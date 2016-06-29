const spawn = require('child_process').spawn;
const CELIO = require('celio');
const winston = require('winston');
const watson = require('watson-developer-cloud');
const program = require('commander');

program
  .version('0.1')
  .option('-n, --nchannels [value]', 'Number of channels to transcribe.', parseInt)
  .parse(process.argv);

const logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Console)({
        'timestamp': ()=>new Date().toLocaleString('en-us', {timeZoneName: 'short'})
      })
    ]
});

const channels = [];
let channelCount = 1;
if (program.nchannels) {
  channelCount = program.nchannels;
}

logger.log('info', `Transcribing ${channelCount} channels.`);

const io = new CELIO();
const transcript = io.getTranscript();

const speech_to_text = watson.speech_to_text(io.config.STT);

io.onCommands('stt', comm => {
  if (comm.command === 'switch-model') {
      logger.log('info', `Switching to the ${comm.model} model.`);
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
  for (let i = 0; i < channelCount; i++) {
    const p = spawn('ffmpeg', [
      '-v', 'error',
      '-f', 'avfoundation',
      '-i', 'none:default',
      '-map_channel', `0.0.${i}`,
      '-acodec', 'pcm_s16le', '-ar', '44100',
      '-f', 'wav', '-']);

    if (channels[i]) {
      channels[i].process = p;
      channels[i].stream = p.stdout;
    } else {
      channels.push({process:p, stream:p.stdout});
    }
  }
}

function stopCapture() {
  logger.log('info', 'Stopping all channels.');
  for (let i = 0; i < channelCount; i++) {
    if (channels[i].process) {
      channels[i].process.kill();
      channels[i].process = null;
    }
    channels[i].stream = null;
  }
}

function startTranscribe(currentModel, transcript) {
  logger.log('info', `Starting all channels with the ${currentModel} model.`);

  for (let i = 0; i < channelCount; i++) {
    const textStream = channels[i].stream.pipe(speech_to_text.createRecognizeStream({
      content_type: 'audio/l16; rate=44100; channels=1',
      model: io.config.models[currentModel],
      inactivity_timeout: -1,
      'x-watson-learning-opt-out': true,
      interim_results: true,
      keywords: ['celia', 'watson'],
      keywords_threshold: 0.01
    }));

    textStream.setEncoding('utf8');
    textStream.on('results', input => {
      const result = input.results[0];

      const msg = {channel: i, result: result, time_captured: new Date().getTime()};
      logger.info(msg);
      transcript.publish(io.config.rabbitMQ.exchange, result.final, msg);
    });
  }
}

startCapture();
startTranscribe('generic', transcript);
