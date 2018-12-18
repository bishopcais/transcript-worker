const spawn = require('child_process').spawn;
const stream = require('stream');
const BinaryRingBuffer = require('@cisl/binary-ring-buffer');
const logger = require('@cisl/logger');
const utils = require('./utils');

const default_language = 'en-US';
const default_model = 'broad';
const default_type = 'far';

module.exports = class Channel {
  constructor(index, options) {
    this.index = index;
    this.language = options.language || default_language;
    this.model = options.model || default_model;
    this.type = options.type || default_type;
    this.raw_buffer = new BinaryRingBuffer(options.buffer_size);
    this.last_message_timestamp = null;
    this.paused = false;
    this.process = undefined;
    this.stream = undefined;

    let device_info = utils.getDeviceInfo(options.device);
    let args = [
      '-v', 'error',
      '-f', device_info.interface,
      '-i', device_info.device,
      '-map_channel', `0.0.${index}`,
      '-acodec', 'pcm_s16le', '-ar', '16000',
      '-f', 'wav', '-'
    ];

    this.process = spawn('ffmpeg', args);

    this.process.stderr.on('data', (data) => {
      logger.error(data.toString());
    });

    this.stream = this.process.stdout();
    this.stream.on('data', (data) => {
      this.raw_buffer.write(data);
    });

    if (this.type === 'far') {
      const pausable = stream.Transform();
      pausable._transform = (chunk, encoding, callback) => {
        if (!this.paused) {
          this.push(chunk);
        }
        callback();
      };

      this.stream = this.stream.pipe(pausable);
    }
  }
};
