const spawn = require('child_process').spawn;
const CELIO = require('celio');
const winston = require('winston');
const watson = require('watson-developer-cloud');
const stream = require('stream');
const fs = require('fs');

if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs');
}

const logger = new (winston.Logger)({
  transports: [
    new winston.transports.File({
        level: 'info',
        colorize: false,
        timestamp: ()=>new Date().toLocaleString('en-us', {timeZoneName: 'short'}),
        filename: 'logs/all-logs.log',
        handleExceptions: true,
        maxsize: 5242880 //5MB
    }),
    new winston.transports.Console({
        level: 'info',
        handleExceptions: true,
        humanReadableUnhandledException: true,
        json: false,
        colorize: true
    }) 
  ]
});

const io = new CELIO();
const transcript = io.getTranscript();
const speaker = io.getSpeaker();

io.config.required(['STT:username', 'STT:password', 'STT:version']);
io.config.defaults({
  'models': {
    generic: 'en-US_BroadbandModel'
  },
  'channels': ["far"]
});

const channelTypes = io.config.get('channels');
logger.info(`Transcribing ${channelTypes.length} channels.`);

const channels = [];
const models = io.config.get('models');
const currentModel = 'generic';

const speech_to_text = watson.speech_to_text(io.config.get('STT'));

let deviceInterface;

 switch (process.platform) {
    case 'darwin':
      deviceInterface = 'avfoundation';
      break;
    case 'win32':
      deviceInterface = 'dshow';
      break;
    default:
      deviceInterface = 'alsa';
      break;
 }

transcript.onSwitchModel(comm => {
  if (!models[comm.model]) {
    logger.info(`Cannot find the ${comm.model} model. Not switching.`);
  } else {
    logger.info(`Switching to the ${comm.model} model.`);
    
    currentModel = comm.model;
    delayedRestart();
  }
});

function delayedRestart() {
  stopCapture();

    // Restart capturing after 1 second.
    // I can't restart transcribing immediately, because I have to wait
    // the previous transcribe sessions to close, otherwise, the server will
    // reject my connections.
    setTimeout(() => {
      startCapture();
    }, 1000);
};

function startCapture() {
  for (let i = 0; i < channelTypes.length; i++) {
    const p = spawn('ffmpeg', [
      '-v', 'error',
      '-f', deviceInterface,
      '-i', 'none:default',
      '-map_channel', `0.0.${i}`,
      '-acodec', 'pcm_s16le', '-ar', '16000',
      '-f', 'wav', '-']);

    p.stderr.on('data', data => {
      logger.error(data.toString());
      process.exit(1);
    });

    let s;

    if (channelTypes[i] !== 'near') {
      let paused = false;

      speaker.onBeginSpeak(() => {
        logger.info(`Pausing channel ${i}`);
        paused = true;
      });

      speaker.onEndSpeak(() => {
        logger.info(`Resuming channel ${i}`);
        paused = false;
      });

      const pausable = new stream.Transform();
      pausable._transform = function(chunk, encoding, callback) {
        if (!paused) {
          this.push(chunk);
        }
        callback();
      };

      s = p.stdout.pipe(pausable);
    } else {
      s = p.stdout;
    }

    if (channels[i]) {
      channels[i].process = p;
      channels[i].stream = s;
    } else {
      channels.push({process:p, stream:s});
    }
  }
  
  transcribe();
}

function stopCapture() {
  logger.info('Stopping all channels.');
  for (let i = 0; i < channelTypes.length; i++) {
    if (channels[i].process) {
      channels[i].process.kill();
      channels[i].process = null;
    }
    channels[i].stream = null;
  }
}

function transcribe() {
  logger.info(`Starting all channels with the ${currentModel} model.`);

  for (let i = 0; i < channelTypes.length; i++) {
    const sttStream = speech_to_text.createRecognizeStream({
      content_type: 'audio/l16; rate=16000; channels=1',
      model: models[currentModel],
      inactivity_timeout: -1,
      smart_formatting: true,
      'x-watson-learning-opt-out': true,
      interim_results: true,
      keywords: io.config.get('keywords'),
      keywords_threshold: io.config.get('keywords_threshold')
    });

    sttStream.on('error', (err) => {
      logger.error(err.message);
      logger.info('An error occurred. Restarting capturing after 1 second.');
      delayedRestart();
    });

    const textStream = channels[i].stream.pipe(sttStream);

    textStream.setEncoding('utf8');
    textStream.on('results', input => {
      const result = input.results[0];

      if (result) {
        const msg = {channel: i, result: result};
        if (result.final) {
          logger.info(JSON.stringify(msg));
        }
        transcript.publish(channelTypes[i], result.final, msg);
      }
    });
  }
}

startCapture();