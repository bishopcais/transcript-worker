const spawn = require('child_process').spawn;
const stream = require('stream');

const express = require('@cisl/express');
const BinaryRingBuffer = require('@cisl/binary-ring-buffer');
const io = require('@cisl/io')();
const logger = require('@cisl/logger');
const SpeechToTextV1 = require('ibm-watson/speech-to-text/v1');
const { BearerTokenAuthenticator } = require("ibm-cloud-sdk-core");

const app = express();

let publish = true;

const config = Object.assign(
  {
    channels: [
      {} // Create a channel that uses all defaults
    ],
    default_driver: 'ffmpeg',
    default_device: 'default',
    default_language: 'en-US',
    default_model: 'broad',
    default_language_model: 'generic',
    language_models: {},
    default_acoustic_model: null,
    acoustic_models: {},
    sample_rate: 16000,
    buffer_size: 512000,
    speaker_id_duration: 5 * 6000,
    max_alternatives: 3,
    publish_interim: false,
  },
  io.config.get('transcribe')
);

let channels = config.channels
let languages;
let models;
let model_names;

let currentLanguageModel;
let languageModels;

let currentAcousticModel;
let acousticModels;

let environmentUUID = null;

let pauseForSpeakerWorker = false;

if (!io.rabbit) {
  logger.warn('Only printing to console, could not find RabbitMQ.');
}
else {
  io.rabbit.onTopic('speaker.speak.begin', () => {
    pauseForSpeakerWorker = true;
  });

  io.rabbit.onTopic('speaker.speak.end', () => {
    pauseForSpeakerWorker = false;
  })
}

if (!(['broad', 'narrow'].includes(config.default_model))) {
  logger.error(`Unsupported model (broad or narrow): ${config.default_model}`);
  process.exit();
}

// let stt_url =
//   "https://cpd-cpd-instance.sbx-cpd-speech-01-e648741016b5b16f9b585588dcd0ed80-0000.us-south.containers.appdomain.cloud/speech-to-text/cpd-instance-speech-prod-cr/instances/1635259471651757/api";

// const bearerToken =
//   "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkhLRXVtd2RyWUpEXzM1VzB3ZzhlSHh0eFV2dmpKeGF3VjFtODFzLTczcnMifQ.eyJ1aWQiOiIxMDAwMzMwOTk5IiwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJBZG1pbiIsInBlcm1pc3Npb25zIjpbImFkbWluaXN0cmF0b3IiLCJjYW5fcHJvdmlzaW9uIl0sImdyb3VwcyI6WzEwMDAwXSwic3ViIjoiYWRtaW4iLCJpc3MiOiJLTk9YU1NPIiwiYXVkIjoiRFNYIiwiaWF0IjoxNjM1MjU5NDcyfQ.sBg3PUj7i_AmIb7jzQqr67pI8R6Zebexbf1gvIciT_TPYSUmy6yeFKIosTqmV_tTFet9f_UhchLa5OuprrYU2xX7x8IOB5tP-c11pQC9Oo4Gm8QHrTto56jyH53HWoM18hqwrzMaXSWZ2mK2FNtC8-iZ1xCjoSrJRmNJM8zg5wMfNGOpqEaZz2CHdvHm4DQU8P_U-xDb89HHm6YGYP6az5K-Z6Z-BnM_LzolLLlRI8Af8KoftIebmcqNrswMhzT_ORkw1ncCbgWiWL2Eamss0VHWChc6ERa2IXnDQqSGIz05wgMuZ1BiucRU6R8an7j2rUm-oE-JzruJMcfZwWKoXA";
// const speechToText = new SpeechToTextV1({
//   authenticator: new BearerTokenAuthenticator({
//     bearerToken: bearerToken,
//   }),
//   disableSslVerification: true,
//   serviceUrl: stt_url,
// });

let watson_stt;
const watsonInfo = io.config.get('watson') || null;
if (watsonInfo && watsonInfo.environment == 'cloudpak') {
  console.log("watsonInfo is: ");
  console.log(JSON.stringify(watsonInfo, null, 2));
  let sttUrl = watsonInfo.sttURL;
  let bearerToken = watsonInfo.bearerToken;
  watson_stt = new SpeechToTextV1({
    authenticator: new BearerTokenAuthenticator({
      bearerToken: bearerToken,
    }),
    disableSslVerification: true,
    serviceUrl: sttUrl,
  });
}
else {
  watson_stt = new SpeechToTextV1({});
}

function getModels() {
  return new Promise((resolve, reject) => {
    watson_stt.listModels(null, (err, res) => {
      if (err) {
        reject(err);
      }
      else {
        resolve(res.result.models);
      }
    });
  });
}

async function initializeWatson() {
  models = await getModels(watson_stt);
  model_names = [];
  languages = [];
  for (let model of models) {
    if (!(languages.includes(model.language))) {
      languages.push(model.language);
    }
    model_names.push(model.name);
  }
  languages.sort();

  /*
  currentLanguageModel = io.config.get('transcribe:default_language_model');
  languageModels = io.config.get('transcribe:language_models');
  currentAcousticModel = io.config.get('transcribe:default_acoustic_model');
  acousticModels = io.config.get('transcribe:acoustic_models');
  */

  currentLanguageModel = config.default_language_model;
  languageModels = config.language_models;
  currentAcousticModel = config.default_acoustic_model;
  acousticModels = config.acoustic_models;
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

function resetSpeaker(idx) {
  channels[idx].speaker = undefined;
  notifyClientsChannel(channels[idx]);
}

function publishTranscript(idx, channel, data) {
  if (data.results && data.results[0] && data.results[0].alternatives && publish && !channel.paused) {
    let result = data.results[0];

    // we always output our first interim result, which we know it is if speechStartTime is null
    if (!channel.speechStartTime) {
      channel.speechStartTime = (new Date()).getTime() / 100;
    }
    else if (!config.publish_interim && !result.final) {
      return;
    }
    let transcript = result.alternatives[0];
    transcript.transcript = transcript.transcript.trim();
    let total_time = 0;
    if (transcript.timestamps) {
      total_time = Math.round((last(last(transcript.timestamps)) - transcript.timestamps[0][1]) * 100) / 100;
    }

    if (channel.speaker) {
      if (channel.speaker_timeout) {
        clearTimeout(channel.speaker_timeout);
      }
      channel.speaker_timeout = setTimeout(() => resetSpeaker(idx), config.speaker_id_duration);
    }

    channel.last_message_timestamp = new Date();

    let msg = {
      worker_id: config.id || 'transcript-worker',
      message_id: io.generateUuid(),
      timestamp: channel.last_message_timestamp,
      channel_idx: idx,
      speaker: channel.speaker,
      language: channel.language,
      transcript: transcript.transcript,
      total_time: total_time,
      result: result,
      speechStartTime: channel.speechStartTime,
      speechEndTime: 0,
      environmentUUID,
    };

    if (result.final) {
      msg.speechEndTIme = (new Date()).getTime() / 100;
      channel.speechStartTime = null;
    }

    if (result.final) {
      logger.info(`Transcript (Channel ${msg.channel_idx}): ${msg.transcript}`);
      if (channel.extract_requested && io.rabbit) {
        channel.extract_requested = false;
        let start_time = transcript.timestamps[0][1];
        let end_time = last(last(transcript.timestamps));

        let start_index = (config.sample_rate * 2 * start_time);
        let end_index = (config.sample_rate * 2 * end_time);
        logger.info(`  > Extracted for analysis`);
        io.rabbit.publishTopic('transcript.pitchtone.audio', channel.raw_buffer.slice(start_index, end_index));
      }
      logger.debug(`Transcript (Channel ${msg.channel_idx}): ${JSON.stringify(msg, null, 2)}`);
      app.wsServer.clients.forEach((client) => {
        client.send(JSON.stringify({
          type: 'transcript',
          data: {
            idx: msg.channel_idx,
            transcript: msg.transcript, timestamp: msg.timestamp.toLocaleTimeString(undefined, {hourCycle:'h24'})
          }
        }));
      });
    }

    if (io.rabbit) {
      io.rabbit.publishTopic(`transcript.result.${result.final ? 'final' : 'interim'}`, msg);
      // LEGACY
      io.rabbit.publishTopic(`far.${result.final ? 'final' : 'interim'}.transcript`, msg);
      // END LEGACY
    }
  }
}

function notifyClientsChannel(channel) {
  app.wsServer.clients.forEach((client) => {
    client.send(JSON.stringify({type: 'channel', data: channel}));
  });
}

function transcribeChannel(idx, channel) {
  logger.info(`opening channel ${idx}: ${channel.driver} - ${channel.device}`);
  if (channel.driver === 'fake') {
    return;
  }
  if (channel.stt_stream) {
    channel.stt_stream.stop();
  }
  let params = {
    objectMode: true,
    model: getModelName(channel.language, channel.model),
    customizationId: languageModels[currentLanguageModel],
    contentType: `audio/l16; rate=${config.sample_rate}; channels=1`,
    inactivityTimeout: -1,
    timestamps: true,
    smartFormatting: true,
    interimResults: true,
    maxAlternatives: config.max_alternatives,
  };

  if (currentAcousticModel) {
    params.acousticCustomizationId = acousticModels[currentAcousticModel];
  }

  logger.info(`  -> model: ${params.model}`);
  if (params.customizationId) {
    logger.info(`  -> customizationId: ${params.customizationId}`);
  }
  if (params.acousticCustomizationId) {
    logger.info(`  -> acousticCustomizationId: ${params.acousticCustomizationId}`);
  }

  channel.stt_stream = watson_stt.recognizeUsingWebSocket(params);
  channel.stream.pipe(channel.stt_stream);
  channel.stt_stream.on('data', (data) => {
    publishTranscript(idx, channel, data);
  });
}

async function startTranscriptWorker() {
  logger.info(`Starting ${channels.length} channel(s)`);
  for (let idx = 0; idx < channels.length; idx++) {
    let channel = channels[idx];
    channel.transcript = [];

    channel.idx = channel.idx || idx;
    channel.driver = channel.driver || config.default_driver;
    channel.device = channel.device || config.default_device;
    channel.language = channel.language || config.default_language;
    if (!(languages.includes(channel.language))) {
      logger.error(`Invalid language for channel ${idx}: ${channel.language}`);
      return;
    }
    channel.model = channel.model || config.default_model;
    let model_full = getModelName(channel.language, channel.model);
    if (!model_names.includes(model_full)) {
      logger.error(`Invalid model for channel ${idx}: ${channel.model} (${model_full})`);
      return;
    }

    channel.paused = false;
    channel.last_message_timestamp = null;
    channel.speaker = undefined;
    channel.speaker_timeout = null;
    channel.extract_requested = false;
    channel.raw_buffer = new BinaryRingBuffer(config.buffer_size);

    if (channel.driver === 'ffmpeg')  {
      let device_info = getDeviceInfo(channel.device);
      let args = [
        '-v', 'error',
        '-f', device_info.interface,
        '-i', device_info.device,
        '-map_channel', `0.0.${channel.idx}`,
        '-acodec', 'pcm_s16le', '-ar', `${config.sample_rate}`,
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
        if (!(channel.paused || pauseForSpeakerWorker)) {
          this.push(chunk);
        }
        callback();
      };

      channel.stream = channel.stream.pipe(pausable);
    }
  }

  if (io.rabbit) {
    io.rabbit.onTopic('transcript.command.switch_language', msg => {
      msg.content.channel_idx = msg.content.channel_idx || msg.content.channelIndex;
      changeLanguage(msg);
    });

    io.rabbit.onTopic('transcript.command.controlAudioCapture', msg => {
      const content = msg.content || {};
      changeChannelPauseState({
        channel_idx: content.channelIndex || content.channel_idx || null,
      }, msg.content.command === 'pause');      
    });
    
    io.rabbit.onTopic('transcript.command.pause', msg => {
      msg.content.channel_idx = msg.content.channel_idx || msg.content.channelIndex;
      changeChannelPauseState(msg.content, true);
    });

    io.rabbit.onTopic('transcript.command.unpause', msg => {
      msg.content.channel_idx = msg.content.channel_idx || msg.content.channelIndex;
      changeChannelPauseState(msg.content, false);
    });

    io.rabbit.onTopic('transcript.command.stop_publish', () => {
      logger.info('Stopping publishing');
      publish = false;
    });

    io.rabbit.onTopic('transcript.command.start_publish', () => {
      logger.info('Starting publishing');
      publish = true;
    });

    io.rabbit.onTopic('transcript.command.extract_pitchtone', msg => {
      let idx = msg.content.channel_idx;
      if (channels[idx]) {
        logger.info(`Extract requested for channel ${idx}`);
        channels[idx].extract_requested = true;
      }
    });

    io.rabbit.onTopic('transcript.command.tag_channel', msg => {
      if (msg.content.channel_idx && msg.content.speaker && channels[msg.content.channel_idx]) {
        logger.info(`Tagging channel ${msg.content.channel_idx}: ${msg.content.speaker}`);
        channels[msg.content.channel_idx].speaker = msg.content.speaker;
      }
    });

    // LEGACY
    io.rabbit.onTopic('controlAudioCapture.transcript.command', {contentType: 'application/json'}, (msg) => {
      const content = msg.content || {};
      changeChannelPauseState({
        channel_idx: content.channelIndex || content.channel_idx || null,
      }, msg.content.command === 'pause');
    });

    io.rabbit.onTopic('transcript.command.switchLanguageModel', {contentType: 'text/string'}, (msg) => {
      const model = msg.content;
      if (!languageModels[model]) {
        logger.info(`Cannot find the ${model} model. Not switching.`);
        return;
      }
      logger.info(`Switching to the ${model} model.`);
      currentLanguageModel = model;
      for (let idx = 0; idx < channels.length; idx++) {
        transcribeChannel(idx, channels[idx]);
      }
    });

    io.rabbit.onTopic('transcript.command.switchAcousticModel', {contentType: 'text/string'}, (msg) => {
      const model = msg.content;
      if (!acousticModels[model]) {
        logger.info(`Cannot find the ${model} acoustic model. Not switching.`);
        return;
      }

      logger.info(`Switching to the ${model} acoustic model.`);
      currentAcousticModel = model;
      for (let idx = 0; idx < channels.length; idx++) {
        transcribeChannel(idx, channels[idx]);
      }
    });

    io.rabbit.onTopic('transcript.command.setEnvironmentUUID', {contentType: 'application/json'}, (msg) => {
      if (msg.content.environmentUUID) {
        environmentUUID = msg.content.environmentUUID;
      }
      else {
        environmentUUID = null;
      }
      logger.info(`Set environmentUUID to ${environmentUUID}`);
    });

    io.rabbit.onRpc(`rpc-transcript-${io.config.get('id')}-tagChannel`, {contentType: 'application/json'}, (msg, reply) => {
      const input = msg.content;
      if (input.channelIndex >= channels.length) {
        return reply('ignored');
      }

      logger.info(
        `Tagging channel ${input.channelIndex} with name: ${input.speaker}`
      );
      channels[input.channelIndex].speaker = input.speaker;
      reply('done');
    });
    // END LEGACY

    io.rabbit.onTopic('transcript.command.restart_channel', (msg) => {
      if (msg.content.channel_idx) {
        transcribeChannel(msg.channel_idx, channels[msg.channel_idx]);
      }
      else {
        for (let i = 0; i < channels.length; i++) {
          transcribeChannel(i, channels[i]);
        }
      }
    });
  }

  logger.info(`Starting to transcribe...`);
  for (let idx = 0; idx < channels.length; idx++) {
    transcribeChannel(idx, channels[idx]);
  }
}

function changeLanguage(msg) {
  logger.info(`Switching languages for ${(!msg.content.channel_idx || isNaN(parseInt(msg.content.channel_idx))) ? 'all' : msg.content.channel_idx} to ${msg.content.language}`);
  if (!msg.content.channel_idx || isNaN(parseInt(msg.content.channel_idx))) {
    for (let idx = 0; idx < channels.length; idx++) {
      if (!model_names.includes(getModelName(msg.content.language, channels[idx].model))) {
        logger.warn(`Invalid model for channel ${msg.content.channel_idx}: ${getModelName(msg.content.language, channels[idx].model)}`);
        continue;
      }
      channels[idx].language = msg.content.language;
      notifyClientsChannel(channels[idx]);
      transcribeChannel(idx, channels[idx]);
    }
  }
  else if (!isNaN(parseInt(msg.content.channel_idx))) {
    const idx = parseInt(msg.content.channel_idx);
    if (!model_names.includes(getModelName(msg.content.language, channels[idx].model))) {
      logger.warn(`Invalid model for channel ${idx}: ${getModelName(msg.content.language, channels[idx].model)}`);
    }
    else {
      channels[idx].language = msg.content.language
      notifyClientsChannel(channels[idx]);
      transcribeChannel(idx, channels[idx]);
    }
  }
}

function changeChannelPauseState(msg, pause) {
  logger.info((pause ? 'Pausing' : 'Unpausing') + ` channel ${(!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) ? 'all' : msg.channel_idx}`);
  if (!msg.channel_idx || isNaN(parseInt(msg.channel_idx))) {
    for (let idx = 0; idx < channels.length; idx++) {
      channels[idx].paused = pause;
      notifyClientsChannel(channels[idx]);
    }
  }
  else if (!isNaN(parseInt(msg.channel_idx))) {
    channels[parseInt(msg.channel_idx)].paused = true;
    notifyClientsChannel(channels[parseInt(msg.channel_idx)]);
  }
}

function stopTranscriptWorker() {
  logger.info('Stopping all channels.');
  for (let channel of config.channels) {
    if (channel.process) {
      channel.process.kill();
      channel.process = null;
    }
    if (channel.stt_stream) {
      channel.stt_stream.stop();
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

function get_channel(channel) {
  const disallowed_keys = ['raw_buffer', 'process', 'stream', 'stt_stream', 'socket', 'speaker_timeout'];
  return Object.keys(channel)
    .filter(key => !disallowed_keys.includes(key))
    .reduce((obj, key) => {
      obj[key] = channel[key];
      return obj;
    }, {});
}

function get_channels() {
  let filtered_channels = [];
  for (const channel of channels) {
    filtered_channels.push(get_channel(channel));
  }
  return filtered_channels;
}

// do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }));

// catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
process.on('SIGTERM', exitHandler.bind(null, { exit: true }));

// catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));

initializeWatson().then(() => {
  startTranscriptWorker();
});

app.get('/', (req, res) => {
  res.render('index', {
    channels: channels
  });
});

app.use(express.static('static'));

app.wsServer.on('connection', (socket) => {
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    }
    catch (ex) {
      socket.send(JSON.stringify({type: 'error', message: `Invalid JSON object sent: ${ex}`}));
      return;
    }

    if (msg.type === 'get_channels') {
      socket.send(JSON.stringify({
        type: 'channels',
        data: get_channels()
      }));
    }
    else if (msg.type === 'get_languages') {
      socket.send(JSON.stringify({
        type: 'languages',
        data: languages
      }));
    }
    else if (msg.type === 'save_channel') {
      channels[msg.data.idx] = msg.data;
      app.wsServer.clients.forEach((client) => {
        client.send(JSON.stringify({type: 'channel', data: get_channel(channels[msg.data.idx])}));
      });
    }
    else if (msg.type === 'transcript') {
      let data = {
        results: [
          {
            alternatives: [
              {
                confidence: 1,
                transcript: msg.data.transcript
              }
            ],
            final: true
          },
        ]
      };
      publishTranscript(msg.data.idx, channels[msg.data.idx], data);
    }
  }
});

app.listen();
