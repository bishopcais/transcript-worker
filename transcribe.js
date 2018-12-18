const spawn = require('child_process').spawn;
const CELIO = require('@cisl/celio');
const logger = require('@cisl/logger');
const BinaryRingBuffer = require('@cisl/binary-ring-buffer');
const SpeechToTextV1 = require('watson-developer-cloud/speech-to-text/v1');
const stream = require('stream');
const utils = require('./utils');
const Channel = require('./channel');

// 5 minutes (in milliseconds)
const speaker_id_duration = 5 * 60000;

const io = new CELIO();
io.config.required(['STT:username', 'STT:password', 'device']);
io.config.defaults({
  channels: [
    {} // Create a channel that uses all defaults
  ],
  device: 'default',
  model: 'broad',
  record: {
    enabled: false,
    file: 'recording.json'
  },
  buffer_size: 1000
});

const model = io.config.get('model').charAt(0).toUpperCase() + io.config.get('model').slice(1);
let language_models = ['en-US_BroadbandModel'];
const watson_stt = new SpeechToTextV1(io.config.get('STT'));
watson_stt.listModels(null, (err, models) => {
  if (err) {
    logger.error(`Error getting models: ${err}`);
  }
  language_models = models;
});

let channels = [];
for (let channel of io.config.get('channels')) {
  channel = new Channel(channel);
  channels.push(new Channel(channel));
}

let publish = true;

logger.info(`Transcribing ${io.config.get('channels').length} channels`);

let device_interface, device;

function getModelName(channel) {
  return `${channel.language}_${channel.model}bandModel`;
}

function checkChannelIndex() {

}

io.rabbitmq.onTopic('transcript.command', (msg) => {
  logger.info('Transcript command received:');
  logger.info(msg);
  if (msg.mic_index && checkChannelIndex(msg.mic_index)) {

  }

  if (msg.command === 'switch_language') {
    logger.info(`Switching microphone ${msg.mic_index} from '${mics[msg.mic_index].language}' to ${msg.language}`);
  }
  else if (msg.command === 'switch_model') {
    // pass
  }
  else if (msg.command === 'stop_publishing') {
    if (msg.mic_index) {
      if (mics[msg.mic_index] != null) {
        logger.error('Invalid mic index requested to stop publishing');
      }
      else {

      }
    }
    else {
      publish = false;
      logger.info('Stop publishing transcripts');
    }
  }
  else if (msg.command === 'start_publishing') {
    if (msg.mic_index) {

    }
    else {
      publish = true;
      logger.info('Start publishing transcripts');
    }
  }
});

function setDefaultChannelValues(channels) {
  for (let i = 0; i < channels.length; i++) {
    if (!channels[i].language) {
      channels[i].language = 'en-US';
    }
    if (!channels[i].type) {
      channels[i].type = 'far';
    }
    if (!channels[i].model) {
      channels[i].model = 'broad';
    }
    channels[i].index = i;
  }
}

function transcribe() {
  logger.info(`Starting all channels.`);

  for (let channel of channels) {
    if (channel.type === 'none') {
      continue;
    }

    let current_model = getModelName(channel);

    const params = {
      model: current_model,
      content_type: 'audio/l16; rate=16000; channels=1',
      inactivity_timeout: -1,
      smart_formatting: true,
      interim_results: true
    };

    const stt_stream = watson_stt.createRecognizeStream(params);
    stt_stream.on('error', (err) => {
      if (err.message) {
        logger.error(err.message);
        logger.info('An error occurred. Restarting SST in 1 second');
        // TODO: delayedRestart()
      }
      else {
        logger.error('Could not connect to STT server');
      }
    });

    const text_stream = channel.stream.pipe(stt_stream);

    text_stream.setEncoding('utf8');
    text_stream.on('results', (output) => {
      const result = output.results[0];
      if (result && publish) {
        if (channel.speaker) {
          logger.info(`Clear tag for channel ${channel.index}`);
          channel.speaker = undefined;
        }

        let total_time = 0;
        if (result.final && result.alternatives && result.alternatives[0].timestamps) {
          total_time = utils.last(utils.last(result.alternatives[0].timestamps));
        }

        const msg = {
          channel_name: channel.type,
          channel_index: channel.index,
          result: result,
          speaker: channel.speaker,
          total_time: total_time
        };

        logger.info(msg);
      }
    });
  }
}

function startCapturing() {
  let device_info = utils.getDeviceInfo(io.config.get('device'));
  let channels = io.config.get('channels');
  for (let i = 0; i < channels.length; i++) {
    let channel = channels[i];
    let raw_buffer = new BinaryRingBuffer(io.config.get('buffer_size'));
    let args = [
      '-v', 'error',
      '-f', device_info['interface'],
      '-i', device_info['device'],
      '-map_channel', `0.0.${i}`,
      '-acodec', 'pcm_s16le', '-ar', '16000',
      '-f', 'wav', '-'
    ];

    let p = spawn('ffmpeg', args);

    p.stderr.on('data', (data) => {
      logger.error(data.toString());
      process.exit(1);
    });

    let s = p.stdout;
    s.on('data', data => {
      raw_buffer.write(data);
    });

    if (channel.type === 'far') {
      let paused = false;

      // on begin speak
      // on end speak

      const pausable = new stream.Transform();
      pausable._transform = (chunk, encoding, callback) => {
        if (!paused) {
          this.push(chunk);
        }
        callback();
      };

      s = s.pipe(pausable);
      channels[i].process = p;
      channels[i].stream = s;
      channels[i].last_message_timestamp = new Date();
      channels[i].raw_buffer = raw_buffer;
    }
  }

  transcribe();
}

setDefaultChannelValues();
startCapturing();
