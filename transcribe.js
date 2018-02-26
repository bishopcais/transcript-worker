const _ = require('lodash');
const spawn = require('child_process').spawn
const CELIO = require('@cel/celio')
const winston = require('winston')
const SpeechToTextV1 = require('watson-developer-cloud/speech-to-text/v1')
//const SpeechToTextV1 = require('./v1')
const stream = require('stream')
const fs = require('fs')
const RawIPC = require('node-ipc').IPC
const wav = require('wav')
const sampleRate = 16000;


if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs')
}

const logger = new (winston.Logger)({
    transports: [
        new winston.transports.File({
            level: 'info',
            colorize: false,
            timestamp: () => new Date().toLocaleString('en-us', { timeZoneName: 'short' }),
            filename: 'logs/all-logs.log',
            handleExceptions: true,
            maxsize: 5242880 // 5MB
        }),
        new winston.transports.Console({
            level: 'info',
            handleExceptions: true,
            json: false,
            colorize: true
        })
    ]
})

const io = new CELIO()
io.config.required(['STT:username', 'STT:password', 'device'])
io.config.defaults({
    'models': {},
    'channels': ['far'],
    'default_model': 'generic',
    'id': io.generateUUID(),
    'record': {
      'enabled': false
    }
})

var channelTypes = io.config.get('channels')
logger.info(`Transcribing ${channelTypes.length} channels.`)

var recordingEnabled = io.config.get('record:enabled');
var recordingFile;
var recordingObj = [];
if (recordingEnabled) {
  recordingFile = io.config.get('record:file');
}

const channels = []
const models = io.config.get('models')
let currentModel = io.config.get('default_model')
const speakerIDDuration = 5 * 60000 // 5 min

let currentKeywords
io.store.getSet('transcript:keywords').then(keywords => (currentKeywords = keywords))
io.store.onChange('transcript:keywords', () => {
    io.store.getSet('transcript:keywords').then(keywords => {
        currentKeywords = keywords
        logger.info('New keywords', currentKeywords)
        delayedRestart()
    })
})

let currentKeywordsThreshold = 0.01

const CircularBuffer = require('./ringBuffer.js');
var rawAudioBuffer = new CircularBuffer(io.config.get('circular_buffer_size'));
var phraseToExtract = "";
var XiongMaoTag= false;
var new_transcript = "";

const speech_to_text = new SpeechToTextV1(io.config.get('STT'))

let deviceInterface
let device
let publish = true

switch (process.platform) {
    case 'darwin':
        deviceInterface = 'avfoundation'
        device = `none:${io.config.get('device')}`
        break
    case 'win32':
        deviceInterface = 'dshow'
        device = `audio=${io.config.get('device')}`
        break
    default:
        deviceInterface = 'alsa'
        device = `${io.config.get('device')}`
        break
}
io.onTopic('CIR.pitchtone.executor', msg=> {
  msg = JSON.parse(msg);
  if (msg.type === "start_listen"){
    XiongMaoTag = true;
    console.log("****" + "message receved");
  }
});
io.onTopic('CIR.pitchtone.request', msg => {
    msg = JSON.parse(msg);
    phraseToExtract = msg.word;
})

io.onTopic('CIR.recording.command', msg => {
    msg = JSON.parse(msg);
    if (msg.enabled) {
      recordingObj = [];
      recordingFile = msg.file;
      recordingEnabled = true;
    }
    else {
      recordingObj = [];
      recordingEnabled = false;
    }
});

io.onTopic('switchLanguage.transcript.command', msg =>{
  stopCapture();
  msg = JSON.parse(msg);
  console.log('SWITCHING');
  if (msg.hasOwnProperty('id') && msg.id > 0) {
    channelTypes[msg.id] = msg.lang;
  }
  else {
    langs = msg.micLang;
    for (let i = 1; i<channelTypes.length && i< langs.length; ++i){
      channelTypes[i] = langs[i];
    }
  }
  logger.info(channelTypes);
  startCapture();
})

io.onTopic('switchModel.transcript.command', msg => {
    const model = msg.toString()
    if (!models[model]) {
        logger.info(`Cannot find the ${model} model. Not switching.`)
    } else {
        logger.info(`Switching to the ${model} model.`)

        currentModel = model
        delayedRestart()
    }
})

io.onTopic('stopPublishing.transcript.command', () => {
    logger.info('Stop publishing transcripts.')
    publish = false
})

io.doCall(`rpc-transcript-${io.config.get('id')}-tagChannel`, (request, reply) => {
  logger.info('tagging');
    const input = JSON.parse(request.content.toString())
    if (channels.length > input.channelIndex) {
        logger.info(`Tagging channel ${input.channelIndex} with name: ${input.speaker}`)
        channels[input.channelIndex].speaker = input.speaker
        reply('done')
    } else {
        reply('ignored')
    }
})
let restarting = false
function delayedRestart() {
    restarting = true
    stopCapture()

    // Restart capturing after 2 seconds.
    // I can't restart transcribing immediately, because I have to wait
    // the previous transcribe sessions to close, otherwise, the server will
    // reject my connections.
    setTimeout(() => {
        startCapture()
    }, 2000)
};

class IPCInputStream extends stream.Readable {
    constructor(options) {
        super(options)
        this.ipc = options.ipc

        const self = this
        options.ipc.serve()
        options.ipc.server.on('data', (data, socket) => {
            self.push(data)
        })
        options.ipc.server.on('disconnect', (data, socket) => {
            self.push(null)
        })

        this.started = false
    }

    _read() {
        if (!this.started) {
            this.ipc.server.start()
            this.started = true
        }
    }
}

function startCapture() {
    for (let i = 0; i < channelTypes.length; i++) {
        let s, p

        if (channelTypes[i] !== 'none') {
            if (io.config.get('device') !== 'IPC') {
                p = spawn('ffmpeg', [
                    '-v', 'error',
                    '-f', deviceInterface,
                    '-i', device,
                    '-map_channel', `0.0.${i}`,
                    '-acodec', 'pcm_s16le', '-ar', '16000',
                    '-f', 'wav', '-'])

                p.stderr.on('data', data => {
                    logger.error(data.toString())
                    process.exit(1)
                })

                s = p.stdout
                s.on('data', data => {
                  rawAudioBuffer.write(data);
                })

            } else {
                const ipc = new RawIPC()
                ipc.config.rawBuffer = true
                ipc.config.appspace = 'beam-'
                ipc.config.id = 'transcript-' + i
                ipc.config.encoding = 'hex'
                s = new IPCInputStream({ ipc })
            }

            if (channelTypes[i] === 'far') {
                let paused = false

                io.speaker.onBeginSpeak(() => {
                    logger.info(`Pausing channel ${i}`)
                    paused = true
                })

                io.speaker.onEndSpeak(() => {
                    logger.info(`Resuming channel ${i}`)
                    paused = false
                })

                const pausable = new stream.Transform()
                pausable._transform = function (chunk, encoding, callback) {
                    if (!paused) {
                        this.push(chunk)
                    }
                    callback()
                }

                s = s.pipe(pausable)
            }
        }

        if (channels[i]) {
            channels[i].process = p
            channels[i].stream = s
            channels[i].lastMessageTimeStamp = new Date()
        } else {
            channels.push({ process: p, stream: s })
        }
    }

    transcribe()
}

function stopCapture() {
    logger.info('Stopping all channels.')
    for (let i = 0; i < channelTypes.length; i++) {
        if (channels[i].process) {
            channels[i].process.kill()
            channels[i].process = null
        }
        channels[i].stream = null
    }
}
//if a pre defined keyword has been found in the transcript, extract the audio for the word and send it over RabbitMQ
function extractPhrase(extractedWord, start, end) {
  startIndex = (sampleRate * 2 * start)
  endIndex = (sampleRate * 2 * end)

  //extract audio bytes with given start and end indexes
  var extractedAudioData = rawAudioBuffer.slice(startIndex, endIndex);
  var writer = new wav.Writer({"sampleRate" : sampleRate, "channels" : 1});
  writer.write(extractedAudioData, ()=>{
    var extractedAudioFile = writer.read();

    //after data has been extracted publish to rabbitmq..
    console.log("extracted " + extractedWord + " for analysis");
    if( XiongMaoTag == true){
      io.publishTopic("CIR.pitchtone.audio", extractedAudioFile);
    }
  });
}






function transcribe() {
    logger.info(`Starting all channels with the ${currentModel} model.`)

    for (let i = 0; i < channelTypes.length; i++) {
        if (channelTypes[i] === 'none') {
            continue
        }
        var current_model;

        if(channelTypes[i] === "en-US")
          current_model="en-US_BroadbandModel";
        else if(channelTypes[i] === "zh-CN")
          current_model="zh-CN_BroadbandModel";


        const params = {
            model: current_model,
            content_type: `audio/l16; rate=16000; channels=1`,
            inactivity_timeout: -1,
            smart_formatting: true,
            interim_results: true
        };
        if (current_model === "en-US_BroadbandModel") {
          params.customization_id = io.config.get('STT:customization_id');
        }

        if (models[currentModel]) {
            params.headers = {'customization-local-path': models[currentModel]}
        }
        if (currentKeywords && currentKeywords.length > 0) {
            params.keywords = currentKeywords
            params.keywords_threshold = currentKeywordsThreshold
        }
        const sttStream = speech_to_text.createRecognizeStream(params)

        sttStream.on('error', (err) => {
            if (!restarting) {
                if (err.message) {
                    logger.error(err.message)
                    logger.info('An error occurred. Restarting capturing after 1 second.')
                    delayedRestart()
                } else {
                    logger.error('Cannot connect to the STT server.')
                    process.exit(1)
                }
            }
        })

        const textStream = channels[i].stream.pipe(sttStream)

        textStream.setEncoding('utf8')
        textStream.on('results', input => {

            const result = input.results[0]
            if (result && publish) {
                // See if we should clear speaker name
                if (channels[i].speaker && (new Date() - channels[i].lastMessageTimeStamp > speakerIDDuration)) {
                    logger.info(`Clear tag for channel ${i}.`)
                    channels[i].speaker = undefined
                }

                let total_time = 0;
                if (result.final && result.alternatives && result.alternatives[0].timestamps) {
                    total_time = _.last(_.last(result.alternatives[0].timestamps));
                }

                const msg = {
                    workerID: io.config.get('id'),
                    channelName: channelTypes[i],
                    channelIndex: i,
                    result: result,
                    speaker: channels[i].speaker,
                    total_time: total_time
                }

                if (result.final) {
                  //find desired keywords in transcript..
                  for(var k = 0; k < result.alternatives.length; k++){
                    console.log("====================");
                     console.log(result.alternatives[k]);
                    let resultData = result.alternatives[k];
                    let transcript = resultData.transcript;
                    let timestamps = resultData.timestamps;



                    var firstword = "";
                    var currentwordlength=0;
                    //check if the word "xiongmao" exists in the transcript
                    for(var m=0;m<transcript.length;m++){
                    if(currentwordlength==2){
                      break;
                     }
                     if(transcript[m]!=" "){
                       firstword = firstword.concat(transcript[m]);
                      currentwordlength++;
                     }
                    }
                    console.log("the first word is");
                    console.log(firstword);




                   let phraseIndex = transcript.indexOf(phraseToExtract);
                   if (!timestamps || phraseIndex == -1) {
                     continue;
                   }

                    //TODO this logic probably doesn't handle a lot of edge cases. Do more thorough testing
                    let matchBuffer = transcript;
                    let startTime = 0, endTime = 0;
                    for(let j = 0; j < timestamps.length; j++){
                      let charIndex = matchBuffer.indexOf(timestamps[j][0]);

                      //Break when we stop finding matches after we've found the first match
                     if (charIndex == -1 && startTime != 0) {
                        break;
                      }
                      else if (charIndex != -1) {
                        //Strip the match out to prevent extra long matches.
                        //e.g. searching for "banana bread" in transcript "banana bread bread banana"
                        matchBuffer = matchBuffer.substring(charIndex + timestamps[j][0].length).trim();

                        //First match sets both start and end times, further matches only update the end time
                        if (startTime == 0) {
                          startTime = timestamps[j][1];
                        }

                        endTime = timestamps[j][2];
                      }
                    }

                    if (startTime != 0 && endTime > startTime) {
                      //extractPhrase(phraseToExtract, startTime, endTime);

                      //send next (speech+txt) starting with XiongMao (currently it sends whatever word it has)
                      console.log(transcript);
                      console.log(phraseToExtract);
                    var compare_string = firstword.localeCompare("熊猫");
                    //extractPhrase(transcript, startTime, endTime);
                    //each time run the program, check for XiongMao to start
                    if(XiongMaoTag == true){
                      if(compare_string == 0){
                       console.log("is XiongMao");
                       for( var s=0; s< timestamps.length;s++){
                         if(timestamps[s][0]=="熊猫"){
                           startTime = timestamps[s][2];
                         }
                       }


                       transcript=transcript.replace("熊猫","");
                       new_transcript = transcript;
                      console.log("new_transcript")
                      console.log(new_transcript)




                    /*
                       for (var w in resultData){
                         if(w=="transcript"){
                           resultData.transcript = new_transcript;
                         }
                         is (w=="timestamp"){
                           for(var t in resultData.timestamps){
                             if(t[0]=="熊猫"){
                               delete resultData.timestamps[t];
                             }
                           }
                         }

                       }
                    */
                       extractPhrase(transcript, startTime, endTime);
                      //transcript= transcript.replace("熊猫","");
                      // new_transcript= transcript;
                       //  = false;

                       io.publishTopic('CIR.pitchtone.transcript',JSON.stringify({
                          'result':{'alternatives':[{'transcript':new_transcript}]}
                       }

                       ))
                       setTimeout(function(){ XiongMaoTag = false; }, 3000);

                       continue;
                     }

                   }else{
                       console.log("new_transcript")
                     new_transcript =transcript;

                     extractPhrase(transcript, startTime, endTime);
                   }


                    }

                  }


                    logger.info(JSON.stringify(msg))

                    //TODO get Unity to directly read from transcript queue instead
                    io.publishTopic('command.firstplayable.client',JSON.stringify({
                      'type':'chat_log_append',
                      'details':{
                        'text':msg.result.alternatives[0].transcript
                      //'text':msg.transcript
                      }
                    }))



                    channels[i].lastMessageTimeStamp = new Date()

                    if (recordingEnabled) {
                        recordingObj.push(msg);
                        fs.writeFileSync(recordingFile, JSON.stringify({
                          "transcripts": recordingObj
                        }));
                    }
                }

                io.transcript.publish(channelTypes[i], result.final, msg)
            }

            if (!publish) {
                const t = result.alternatives[0].transcript
                if (t.indexOf('start listen') > -1 || t.indexOf('resume listen') > -1 || t.indexOf('begin listen') > -1) {
                    logger.info('Resume listening.')
                    publish = true
                }
            }

            //test code for chinese service from wen & kelvin
            /*
            const result = input.results
            if (result && publish){
                if (channels[i].speaker && (new Date() - channels[i].lastMessageTimeStamp > speakerIDDuration)) {
                    logger.info(`Clear tag for channel ${i}.`)
                    channels[i].speaker = undefined
                }
                const msg = {
                    workerID: io.config.get('id'),
                    channelName: channelTypes[i],
                    channelIndex: i,
                    result: result,
                    speaker: channels[i].speaker
                }
                if (input.final){
                    logger.info(JSON.stringify(msg))
                    channels[i].lastMessageTimeStamp = new Date()
                }
                io.transcript.publish(channelTypes[i], input.final, msg)
            }
            if (!publish) {
                if (result.indexOf('start listen') > -1 || result.indexOf('resume listen') > -1 || result.indexOf('begin listen') > -1) {
                    logger.info('Resume listening.')
                    publish = true
                }
            }*/

        })
    }
}

startCapture()

process.stdin.resume()// so the program will not close instantly

function exitHandler(options, err) {
    if (options.cleanup) stopCapture()
    if (err) console.log(err.stack)
    if (options.exit) process.exit()
}

// do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }))

// catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }))
process.on('SIGTERM', exitHandler.bind(null, { exit: true }))

// catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit: true }))
