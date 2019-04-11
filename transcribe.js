const spawn = require('child_process').spawn;
const stream = require('stream');
const wav = require('wav');

const app = require('@cisl/cais-express');
const BinaryRingBuffer = require('@cisl/binary-ring-buffer');
const io = require('@cisl/celio');
const logger = require('@cisl/logger');

const SpeechToTextV1 = require('ibm-watson/speech-to-text/v1');

let publish = true;

io.config.required(['STT:username', 'STT:password']);
io.config.defaults({
  channels: [
    {} // Create a channel that uses all defaults
  ],
  customizations: {
    acoustic: {
    },
    language: {
    }
  },
  default_device: 'default',
  default_language: 'en-US',
  default_model: 'broad',
  default_acoustic_customization: {
    'en-US': null
  },
  default_language_customization: {
    'en-US': null
  },
  sample_rate: 16000,
  buffer_size: 1000,
  speaker_id_duration: 5 * 6000
});

let channels = io.config.get('channels');

if (!io.mq) {
  logger.warn('Only printing to console, could not find RabbitMQ.');
}

if (!(['broad', 'narrow'].includes(io.config.get('default_model')))) {
  logger.error(`Unsupported model (broad or narrow): ${io.config.get('default_model')}`);
  process.exit();
}

function getLanguageModels(watson_stt) {
  return new Promise((resolve, reject) => {
    watson_stt.listModels(null, (err, models) => {
      if (err) {
        reject(err);
      }
      else {
        resolve(models.models);
      }
    });
  });
}

function getModelName(language, model) {
  return language + '_' + model.substr(0, 1).toUpperCase() + model.substr(1) + 'bandModel';
}

function getDeviceInfo(device_name) {
  let device_interface, device;
  switch (process.platform) {
    case 'darwin':
      device_interface = 'avfoundation';
      device = `none:${device_name}`;
      break;
    case 'win32':
      device_interface = 'dshow';
      device = `audio=${device_name}`;
      break;
    default:
      device_interface = 'alsa';
      device = device_name;
      break;
  }
  return {
    interface: device_interface,
    device: device
  };
}

function last(array) {
  const length = array === null ? 0 : array.length;
  return length ? array[length - 1] : undefined;
}

function transcribeChannel(watson_stt, idx, channel) {
  if (channel.stt_stream) {
    channel.stt_stream.destroy();
  }
  let params = {
    objectMode: true,
    model: getModelName(channel.language, channel.model),
    content_type: `audio/l16; rate=${io.config.get('sample_rate')}; channels=1`,
    inactivity_timeout: -1,
    timestamps: true,
    smart_formatting: true,
    interim_results: true
  };

  channel.stt_stream = watson_stt.recognizeUsingWebSocket(params);
  channel.stream.pipe(channel.stt_stream);
  channel.stt_stream.on('data', (data) => {
    if (data.results && data.results[0] && data.results[0].alternatives && publish && !channel.paused) {
      let result = data.results[0];
      let transcript = result.alternatives[0];
      transcript.transcript = transcript.transcript.trim();
      let total_time = 0;
      if (transcript.timestamps) {
        total_time = Math.round((last(last(transcript.timestamps)) - transcript.timestamps[0][1]) * 100) / 100;
      }

      let speaker_duration = io.config.get('speaker_id_duration');

      if (speaker_duration !== false &&
          channel.speaker && speaker_duration > 0 && 
          (new Date() - channel.last_message_timestamp) > speaker_duration) {
        logger.info(`Clear tag for channel ${idx} (${channel.speaker}).`);
        channel.speaker = undefined;
      }


      channel.last_message_timestamp = new Date();

      let msg = {
        worker_id: io.config.get('id') || 'transcript-worker',
        message_id: io.generateUUID(),
        timestamp: channel.last_message_timestamp,
        channel_idx: idx,
        speaker: channel.speaker,
        transcript: transcript.transcript,
        total_time: total_time,
        result: result
      };

      if (channel.extract_requested && io.mq) {
        channel.extract_requested = false;
        let start_time = transcript.timestamps[0][1];
        let end_time = last(last(transcript.timestamps));

        let start_index = (io.config.get('sample_rate') * 2 * start_time);
        let end_index = (io.config.get('sample_rate') * 2 * end_time);

        // extract audio bytes with given start and end indexes
        let writer = new wav.Writer({'sampleRate': io.config.get('sample_rate'), 'channels': 1});
        writer.write(channel.raw_buffer.slice(start_index, end_index), () => {
          // after data has been extracted publish to rabbitmq..
          console.log(`Extracted ${msg.transcript} for analysis`);
          io.publishTopic('transcript.pitchtone.audio', writer.read());
        });
      }

      if (result.final) {
        logger.info(`Transcript (Channel ${msg.channel_idx}): ${msg.transcript}`);
        logger.debug(`Transcript (Channel ${msg.channel_idx}): ${JSON.stringify(msg, null, 2)}`);
      }

      if (io.mq) {
        io.mq.publishTopic(`transcript.result.${result.final ? 'final' : 'interim'}`, JSON.stringify(msg));
      }
    }
  });
}

async function startTranscriptWorker() {
  const watson_stt = new SpeechToTextV1(io.config.get('STT'));

  let models = await getLanguageModels(watson_stt);
  let model_names = [];
  let languages = [];
  for (let model of models) {
    if (!(languages.includes(model.language))) {
      languages.push(model.language);
    }
    model_names.push(model.name);
  }

  logger.info(`Starting ${channels.length} channel(s):`);
  for (let idx = 0; idx < channels.length; idx++) {
    let channel = channels[idx];
    channel.idx = channel.idx || idx;
    channel.device = channel.device || io.config.get('default_device');
    channel.language = channel.language || io.config.get('default_language');
    if (!(languages.includes(channel.language))) {
      logger.error(`Invalid language for channel ${idx}: ${channel.language}`);
      return;
    }
    channel.model = channel.model || io.config.get('default_model');
    let model_full = getModelName(channel.language, channel.model);
    if (!model_names.includes(model_full)) {
      logger.error(`Invalid model for channel ${idx}: ${channel.model} (${model_full})`);
      return;
    }

    channel.paused = false;
    channel.last_message_timestamp = null;
    channel.speaker = undefined;
    channel.extract_requested = false;
    channel.raw_buffer = new BinaryRingBuffer(io.config.get('buffer_size'));

    if (channel.device === 'ipc') {

    }
    else {
      let device_info = getDeviceInfo(channel.device);
      let args = [
        '-v', 'error',
        '-f', device_info.interface,
        '-i', device_info.device,
        '-map_channel', `0.0.${channel.idx}`,
        '-acodec', 'pcm_s16le', '-ar', io.config.get('sample_rate'),
        '-f', 'wav', '-'
      ];

      channel.process = spawn('ffmpeg', args);

      channel.process.stderr.on('data', data => {
        logger.error(data.toString());
        process.exit(1);
      });

      channel.stream = channel.process.stdout;
      channel.stream.on('data', (data) => {
        channel.raw_buffer.write(data);
      });

      const pausable = stream.Transform();
      pausable._transform = function(chunk, encoding, callback) {
        if (!channel.paused) {
          this.push(chunk);
        }
        callback();
      };

      channel.stream = channel.stream.pipe(pausable);
    }
    logger.info(`  ${idx}: ${channel.language} - ${channel.model} - ${channel.device}`);
  }

  if (io.mq) {
    io.mq.onTopic('transcript.command.switch_language', msg => {
      logger.info(`Switching languages for ${(!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) ? 'all' : msg.channel_idx} to ${msg.language}`);
      if (!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) {
        for (let idx = 0; idx < channels.length; idx++) {
          if (!model_names.includes(getModelName(msg.language, channels[idx].model))) {
            logger.warn(`Invalid model for channel ${msg.channel_idx}: ${getModelName(msg.language, channels[idx].model)}`);
            continue;
          }
          channels[idx].language = msg.language;
          transcribeChannel(watson_stt, idx, channels[idx]);
        }
      }
      else if (!isNaN(parseInt(msg.channel_idx))) {
        if (!model_names.includes(getModelName(msg.language, channels[msg.channel_idx].model))) {
          logger.warn(`Invalid model for channel ${msg.channel_idx}: ${getModelName(msg.language, channels[msg.channel_idx].model)}`);
        }
        else {
          transcribeChannel(watson_stt, parseInt(msg.channel_idx), channels[parseInt(msg.channel_idx)]);
        }
      }
    });

    io.mq.onTopic('transcript.command.pause', msg => {
      logger.info(`Pausing channel ${(!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) ? 'all' : msg.channel_idx}`);
      if (!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) {
        for (let idx = 0; idx < channels.length; idx++) {
          channels[idx].paused = true;
        }
      }
      else if (!isNaN(parseInt(msg.channel_idx))) {
        channels[parseInt(msg.channel_idx)] = true;
      }
    });

    io.mq.onTopic('transcript.command.unpause', msg => {
      logger.info(`Unpausing channel ${(!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) ? 'all' : msg.channel_idx}`);
      if (!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) {
        for (let idx = 0; idx < channels.length; idx++) {
          channels[idx].paused = false;
        }
      }
      else if (!isNaN(parseInt(msg.channel_idx))) {
        channels[parseInt(msg.channel_idx)] = false;
      }
    });

    io.mq.onTopic('transcript.command.stop_publish', msg => {
      logger.info('Stopping publishing');
      publish = false;
    });

    io.mq.onTopic('transcript.command.start_publish', msg => {
      logger.info('Starting publishing');
      publish = true;
    });

    io.mq.onTopic('transcript.command.extract_pitchtone', msg => {
      if (msg.channel_idx && channels[msg.channel_idx]) {
        logger.info(`Extract requested for channel ${msg.channel_idx}`);
        channels[msg.channel_idx].extract_requested = true;
      }
    });

    io.mq.onTopic('transcript.command.tag_channel', msg => {
      if (msg.channel_idx && msg.speaker && channels[msg.channel_idx]) {
        logger.info(`Tagging channel ${msg.channel_idx}: ${msg.speaker}`);
        channels[msg.channel_idx].speaker = msg.speaker;
      }
    });
  }

  logger.info(`Starting transcription`);
  for (let idx = 0; idx < channels.length; idx++) {
    transcribeChannel(watson_stt, idx, channels[idx]);
  }
}

function stopTranscriptWorker() {
  logger.info('Stopping all channels.');
  for (let channel of io.config.get('channels')) {
    if (channel.process) {
      channel.process.kill();
      channel.process = null;
    }
    if (channel.stt_stream) {
      channel.stt_stream.destroy();
    }
    channel.stream = null;
    channel.raw_buffer = null;
  }
}

function exitHandler(options, err) {
  if (options.cleanup) {
    stopTranscriptWorker();
  }
  if (err && err.stack) {
    console.log(err.stack);
  }
  if (options.exit) {
    process.exit();
  }
}

// do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }));

// catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
process.on('SIGTERM', exitHandler.bind(null, { exit: true }));

// catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));

startTranscriptWorker();

app.get('/', (req, res) => {
  res.render('index', {
    channels: channels
  });
});

app.listen();
