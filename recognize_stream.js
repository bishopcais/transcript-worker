//var WebSocket = require("ws");
var fs = require('fs');
//var Blob = fs.readFileSync('./sample.wav');
const Duplex = require('stream').Duplex;
const util = require('util');
const extend = require('extend');
const pick = require('object.pick');
const W3CWebSocket = require('websocket').w3cwebsocket;

var OPENING_MESSAGE_PARAMS_ALLOWED = ['action', 'format', 'vad', 'interim_results'];

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

  const url = (options.url || 'wss://crl.ptopenlab.com:8800/asr/api/decode').replace(/^http/, 'ws');
  //console.log(url);
//var wsURI = 'ws://localhost:8080/asr/api/decode';
  //var websocket = new WebSocket(wsURI);

  var openingMessage = {'action': 'start', 'format': 'audio/l16', 'continuous': true, 'interim_results': true};
  var closingMessage = {'action': 'stop'};

  //console.log(openingMessage);

  const self = this;
  const socket = (this.socket = new W3CWebSocket(url, null, null, options.headers, null));

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

    if (typeof frame.data !== 'string') {
      return emitError('Unexpected binary data received from server', frame);
    }
    console.log('recognition result in json format: ' + frame.data);
    let data;
    try {
      data = JSON.parse(frame.data);

    } catch (jsonEx) {
      return emitError('Invalid JSON received from service:', frame, jsonEx);
    }
    console.log(data.results);
    console.log(data.result);

    let recognized = false;
    if (data.state === 'error') {
      console.log('error');
      emitError(data.error, frame);
      recognized = true;
    }

    if (data.state === 'listening') {
      if (!self.listening) {
        self.listening = true;
        self.emit('listening');
      } else {
        self.listening = false;
        socket.close();
      }
      recognized = true;
    }

    if (data.result) {
      console.log('result');
      self.emit('results', data);
      if (data.results[0] && data.results[0].final && data.results[0].alternatives) {
        self.push(data.results[0].alternatives[0].transcript, 'utf8'); // this is the "data" event that can be easily piped to other streams
      }
      recognized = true;
    }

    if (!recognized) {
      emitError('Unrecognised message from server', frame);
    }

/*
    var current = JSON.parse(evt.data);
    console.log('recognition result in json format: ' + evt.data);
    var check = current.state;
    if (check == null){
      console.log(current.final + '--' + current.results);
      return;
    }

    if (check == 'listening'){
      console.log('HERE??');
    }
    if (check == 'stopped'){
      //console.log('HELLO??'+ current.info);
      onclose();
    }
*/
  }
}

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
       if (!this.options['format']) {
         this.options['format'] = RecognizeStream.getContentType(chunk);
       }
       this.initialize();
     }
     this.once('listening', function() {
       self.socket.send(chunk);
       self.afterSend(callback);
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

const headerToContentType = {
  fLaC: 'audio/flac',
  RIFF: 'audio/wav',
  OggS: 'audio/ogg',
  '\u001aEߣ': 'audio/webm' // String for first four hex's of webm: [1A][45][DF][A3] (https://www.matroska.org/technical/specs/index.html#EBML)
};
RecognizeStream.getContentType = function(buffer) {
  const header = buffer.slice(0, 4).toString();
  return headerToContentType[header];
};


module.exports = RecognizeStream;
//RecognizeStream();
