const spawn = require('child_process').spawn;
const CELIO = require('celio');
const winston = require('winston');
const watson = require('watson-developer-cloud');
const stream = require('stream');

const logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Console)({
        'timestamp': ()=>new Date().toLocaleString('en-us', {timeZoneName: 'short'})
      })
    ]
});

const io = new CELIO();
const transcript = io.getTranscript();
const speaker = io.getSpeaker();

io.config.required(['channels', 'STT:username', 'STT:password', 'STT:version']);
io.config.defaults({
  'models': {
    generic: 'en-US_BroadbandModel'
  }
});

const channelTypes = io.config.get('channels');
logger.info(`Transcribing ${channelTypes.length} channels.`);

const channels = [];
const models = io.config.get('models');

const speech_to_text = watson.speech_to_text(io.config.get('STT'));

transcript.onSwitchModel(comm => {
  if (!models[comm.model]) {
    logger.info(`Cannot find the ${comm.model} model. Not switching.`);
  } else {
    logger.info(`Switching to the ${comm.model} model.`);
    stopCapture();

    // Restart capturing after 1 second.
    // I can't restart transcribing immediately, because I have to wait
    // the previous transcribe sessions to close, otherwise, the server will
    // reject my connections.
    setTimeout(model => {
      startCapture();
      startTranscribe(model, transcript);
    }, 1000, comm.model);
  }
});

function startCapture() {
  for (let i = 0; i < channelTypes.length; i++) {
    const p = spawn('ffmpeg', [
      '-v', 'error',
      '-f', 'avfoundation',
      '-i', 'none:default',
      '-map_channel', `0.0.${i}`,
      '-acodec', 'pcm_s16le', '-ar', '44100',
      '-f', 'wav', '-']);

    let paused = false;

    speaker.onBeginSpeak(() => {
      console.log(`Pausing channel ${i}`);
      paused = true;
    });

    speaker.onEndSpeak(() => {
      console.log(`Resuming channel ${i}`);
      paused = false;
    });

    const pausable = new stream.Transform();
    pausable._transform = function(chunk, encoding, callback) {
      if (!paused) {
        this.push(chunk);
      }
      callback();
    };

    let s;

    if (channelTypes[i] !== 'close') {
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

function startTranscribe(currentModel, transcript) {
  logger.info(`Starting all channels with the ${currentModel} model.`);

  for (let i = 0; i < channelTypes.length; i++) {
    const textStream = channels[i].stream.pipe(speech_to_text.createRecognizeStream({
      content_type: 'audio/l16; rate=44100; channels=1',
      model: models[currentModel],
      inactivity_timeout: -1,
      smart_formatting: true,
      'x-watson-learning-opt-out': true,
      interim_results: true,
      keywords: io.config.get('keywords'),
      keywords_threshold: io.config.get('keywords_threshold')
    }));

    textStream.setEncoding('utf8');
    textStream.on('results', input => {
      const result = input.results[0];

      if (result) {
        const msg = {channel: i, result: result};
        logger.info(msg);
        transcript.publish(channelTypes[i], result.final, msg);
      }
    });
  }
}

startCapture();
startTranscribe('generic', transcript);
