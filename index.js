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
			// var endAudioChunk = audioChunk.slice(0, endChunkLength);
			// var beginningAudioChunk = audioChunk.slice(endChunkLength, audioChunk.length);

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



//var CircularBuffer = require('./');
//var cb = new CircularBuffer(5 );


// const buf = new Buffer([0x62, 0x75]);
// cb.write(buf);
// console.log(cb.getBuffer());

// const slicedBuff = cb.slice(10,11 + 1);
// console.log(slicedBuff);


// const buf2 = new Buffer([0x68, 0x73]);
// cb.write(buf2);
// console.log(cb.getBuffer());


// const buf3 = new Buffer([0x61, 0x71]);
// cb.write(buf3);
// // console.log(cb.getBuffer());


// const buf4 = new Buffer([0x66]);
// cb.write(buf4);

// const buf2 = new Buffer([0x66]);
// cb.write(buf2);
// console.log(cb.getBuffer());

// const buf3 = new Buffer([0x67,0x68])
// cb.write(buf3);
// console.log(cb.getBuffer());

// const buf4 = new Buffer([0x67,0x68])
// cb.write(buf4);
// console.log(cb.getBuffer());
// const buf5 = new Buffer([0x67,0x68])
// cb.write(buf5);
// console.log(cb.getBuffer());
// const buf6 = new Buffer([0x67,0x68])
// cb.write(buf6);
// console.log(cb.getBuffer());
// const buf7 = new Buffer([0x67,0x68])
// cb.write(buf7);
// console.log(cb.getBuffer());


// console.log(cb.getBuffer.size)
