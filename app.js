
var WebSocket = require("ws");
var fs = require('fs');
var Blob = fs.readFileSync('./sample.wav');
var openingmessage = {'action': 'start', 'format': 'audio/l16', 'vad': true, 'interim_results': true};
var closingmessage = {'action': 'stop'};



function onMessage(evt) {
  var current = JSON.parse(evt.data);
  console.log('recognition result in json format: ' + evt.data);
  var check = current.state;
  //console.log(data.results);
  if (check == null){
    console.log(current.final + '--' + current.results);
    return;
  }
  /*if (check == 'listening'){

    console.log('HERE??');
  }*/
  if (check == 'stopped'){
    //console.log('HELLO??'+ current.info);
    onClose();
  }
}

function onOpen(evt) {
  console.log('Connected to ' + wsURI);
  websocket.send(JSON.stringify(openingmessage));
  websocket.send(Blob);
  websocket.send(JSON.stringify(closingmessage));
}
function onClose(evt) {
  //console.log('Disconnected');
  websocket.close();
}
function onError(evt) {
  //console.log(evt);
  console.log("Error");
}

var wsURI = 'http://129.161.106.119:8080/asr/api/decode';
var websocket = new WebSocket(wsURI);
websocket.onopen = function(evt) { onOpen(evt) };
websocket.onclose = function(evt) { onClose(evt) };
websocket.onmessage = function(evt) { onMessage(evt) };
websocket.onerror = function(evt) { onError(evt) };
