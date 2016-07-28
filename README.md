# Transcript-Worker

You must have **ffmpeg** installed.
On a mac, you can use `brew install ffmpeg --with-opus --with-ffplay`.

Note that this always uses the default device to capture audio,
so make sure you set the correct default audio input device in your OS settings.

To run this, you need to have a cog.json file in your package directory.
The cog.json file needs to have at least the following fields:
```json
{
  "mq": {
    "url": "mq url",
    "username": "username",
    "password": "password",
  },
  "STT": {
    "username": "Your Watson STT username",
    "password": "Your Password",
    "version": "v1"
  },
  "id": "ID to distinguish this transcript worker from others", 
  "device": "devicename",
  "channels": ["far"]
}
```
To find out device names:
On Windows, use: `ffmpeg -list_devices true -f dshow -i dummy`.
On Mac, use: `ffmpeg -list_devices true -f avfoundation -i dummy`.
On Linux, use: `arecord -L`.
For Mac and Linux, you can also just use **default**, and choose the device from the system dialog.

The `channels` field lists the types of microphone for each channel.
If you just want to transcribe one channel, you can use ["far"], for example.

The messages are published to RabbitMQ with the topic keys channelType.interim.transcript and channelType.final.transcript.
The "interim" channel only contains intermediate results while the "final" channel only has the full sentence results.
You can use CELIO's transcript object to subscribe to these topics.

The messages are javascript objects with the following format:
```javascript
{
  workerID: "string"
  channelIndex: num,
  speaker: "speaker_name (optional)",
  result: {
    alternatives: [{transcript: "message", confidence: 0.9}],
    final: true,
    keyword_result: {}
  },
  time_captured: unix_time,
  messageId: "uuid_string",
}
```

## Features
- Add keywords remotely.
- Stop and resume listening. Listening is resumed with the folloing keywords: 'start listening', 'resume listening', and 'begin listening'.
- Pause listening on far-range micrphone channels when the agent is speaking. 
- Supports channel tagging. The channel tag is cleared after five minutes of silence.