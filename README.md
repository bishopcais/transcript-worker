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
    "exchange": "exchange name"
  },
  "STT": {
    "username": "Your Watson STT username",
    "password": "Your Password",
    "version" "v1"
  },
  "channels": ["far"],
  "keywords": ["watson", "celia"],
  "keywords_threshold": 0.01
}
```
The channels list the type of microphone for each channel.
If you just want to transcribe one channel, you can use ["far"], for example.

The messages are published to RabbitMQ with the topic keys channelType.interim.transcript and device.final.transcript.
The "interim" channel only contains intermediate results while the "final" channel only has the full sentence results.
You can use CELIO's transcript object to subscribe to these topics.

The messages are javascript objects with the following format:
```javascript
{
  channel: "channel_num",
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
