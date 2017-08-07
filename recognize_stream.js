//var WebSocket = require("ws");
//var Blob = fs.readFileSync('./sample.wav');
var Duplex = require('stream').Duplex;
var util = require('util');
var extend = require('extend');
var pick = require('object.pick');
var W3CWebSocket = require('websocket').w3cwebsocket;

var OPENING_MESSAGE_PARAMS_ALLOWED = ['action', 'format', 'vad', 'continuous', 'max_alternatives', 'timestamps', 'word_confidence', 'inactivity_timeout', 'interim_results', 'keywords', 'keywords_threshold', 'word_alternatives_threshold', 'profanity_filter', 'smart_formatting' ];

//var OPENING_MESSAGE_PARAMS_ALLOWED = ['action', 'format', 'vad', 'interim_results'];

function RecognizeStream(options) {
  //console.log(options);
  Duplex.call(this, options);
  this.options = options;
  this.listening = false;
  this.initialized = false;
}
util.inherits(RecognizeStream, Duplex);

RecognizeStream.prototype.initialize = function() {
  const options = this.options;
  //console.log(options['content_type']);
  //console.log(options.content_type);
  if (options.content_type && !options['content-type']) {
    options['content-type'] = options.content_type;
  }

  const url = (options.url || 'wss://crl.ptopenlab.com:8800/asr/api/decode').replace(/^http/, 'ws');
//var wsURI = 'ws://localhost:8080/asr/api/decode';
  //var websocket = new WebSocket(wsURI);


  var openingMessage = extend({action: 'start', 'format': 'audio/wav', 'vad': true, 'interim_results': true,
      word_confidence: true,
      continuous: true,
      timestamps: true,
      max_alternatives: 3,
      inactivity_timeout: 600}, pick(options, OPENING_MESSAGE_PARAMS_ALLOWED));
  var closingMessage = {'action': 'stop'};

  var self = this;
  var socket = this.socket = new W3CWebSocket(url, null, null, options.headers, null);

  self.on('finish', function() {
    if (self.socket && self.socket.readyState === W3CWebSocket.OPEN) {
      self.socket.send(JSON.stringify(closingMessage));
     }
    else {
      self.once('connect', function() {
        self.socket.send(JSON.stringify(closingMessage));
     });
    }
  });

  socket.onerror = function(error) {
    self.listening = false;
    self.emit('error', error);
  };

  this.socket.onopen = function() {
    socket.send(JSON.stringify(openingMessage));
    //socket.send(Blob);
    self.emit('connect');
  };

  this.socket.onclose = function(e) {
    self.listening = false;
    self.push(null);
    self.emit('close', e.code, e.reason);
  };

  function emitError(msg, frame, err) {
    if (err) {
      err.message = msg + ' ' + err.message;
    } else {
      err = new Error(msg);
    }
    err.raw = frame;
    self.emit('error', err);
  }

  socket.onmessage=function(frame){
    console.log('recognition result in json format' + frame.data);
    if (typeof frame.data !== 'string') {
      return emitError('Unexpected binary data received from server', frame);
    }
    //console.log('recognition result in json format: ' + frame.data);
    let data;
    try {
      data = JSON.parse(frame.data);

    } catch (jsonEx) {
      return emitError('Invalid JSON received from service:', frame, jsonEx);
    }

    if (data.error) {
      emitError(data.error, frame);
      recognized = true;
    }

    if (data.state === 'listening') {
      // this is emitted both when the server is ready for audio, and after we send the close message to indicate that it's done processing
      if (!self.listening) {
        self.listening = true;
        self.emit('listening');
      } else {
        self.listening = false;
        socket.close();
      }
      recognized = true;
    }
    if (data.state == null) {
      self.emit('results', data);
      if (data.final){
        self.push(data.results, 'utf8');    // this is the "data" event that can be easily piped to other streams
        //console.log('recognition result in json format' + frame.data);
      }
      recognized = true;
    }

    if (data.state === 'stopped'){
      //console.log('stopped');
      socket.send(JSON.stringify(closingMessage));
      socket.send(JSON.stringify(openingMessage));
      self.emit('connect');
      recognized = true;
    }
    if (!recognized) {
      emitError('Unrecognised message from server', frame);
    }
    this.initialized = true;

  };
};

  RecognizeStream.prototype._read = function(/* size*/) {

  };

  RecognizeStream.prototype._write = function(chunk, encoding, callback) {
   const self = this;
   if (self.listening) {
     self.socket.send(chunk);
     this.afterSend(callback);
   }
   else {
     if (!this.initialized) {
       if (!this.options['content_type']) {
         this.options['content_type'] = RecognizeStream.getContentType(chunk);
       }
       this.initialize();
     }
     this.once('listening', function() {
       self.socket.send(chunk);
       this.afterSend(callback);
     });
    }
   };

  RecognizeStream.prototype.afterSend = function afterSend(next) {
   if (this.socket.bufferedAmount <= (this._writableState.highWaterMark || 0)) {
     process.nextTick(next);
   } else {
     setTimeout(this.afterSend.bind(this, next), 10);
   }
  };

  RecognizeStream.prototype.stop = function() {
    this.emit('stopping');
    this.listening = false;
    this.socket.close();
  };

var headerToContentType = {
  fLaC: 'audio/flac',
  RIFF: 'audio/wav',
  OggS: 'audio/ogg',
};

RecognizeStream.getContentType = function(buffer) {
  var header = buffer.slice(0, 4).toString();
  return headerToContentType[header];
};

module.exports = RecognizeStream;
