/*
A node.js implementation of a circular ring buffer optimized for storing real time
audio data
*/
module.exports = function CISL_CircularBuffer(size){
  var buffer = new Buffer(size);
  buffer.fill(0);

  this.buffer = buffer;
  this.head = 0;
  this.tail = 0;
  this.size = size;


  this.getBuffer = function() {
    return this.buffer;
  }

  this.getSize = function() {
    return this.size;
  }
  this.getLength = function() {
    return this.buffer.length;
  }

  //TODO FINISH IMPLEMENTATION..
  //reads the first n bytes of the buffer..
  this.read = function read(n) {

  };

  //
  //writes bytes to the buffer..
  this.write = function write(audioChunk){
    //start writing to the beginning of the buffer if the given data exceeds the buffer size
    if(audioChunk.length + this.tail > this.size){
      var endChunkLength = (this.size - this.tail);
      var beginningChunkLength = (audioChunk.length - endChunkLength);

      //get chunk to write to the beginning and end of the buffer
      audioChunk.slice(0, endChunkLength).copy(this.buffer, this.tail);
      audioChunk.slice(endChunkLength, audioChunk.length).copy(this.buffer, this.head);

      //shift head and tail pointers..
      this.head += beginningChunkLength;
      this.head %= this.size;
      this.tail += endChunkLength;
      this.tail %= this.size;
    }
    else{
      audioChunk.copy(this.buffer, this.tail);
      this.tail += audioChunk.length;
    }
  };

  //slice the buffer given a start and an end
  this.slice = function(start, end){
    start %= this.size;
    end %= this.size;

    return this.buffer.slice(start, end);
  };
};
