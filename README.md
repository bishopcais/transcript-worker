# Transcript-Worker

## Requirements
* You must have **ffmpeg** installed.

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
  "channels": ["near", "far"],
  "keywords": ["optinal", "array"],
  "keywords_threshold": 0.01
}
```
The channels list the type of microphone for each channel.
If you just want to transcribe one channel, you can use ["far"], for example.

The messages are published to RabbitMQ with the topic keys channelType.interim.transcript and device.final.transcript.
The "interim" channel only contains intermediate results while the "final" channel only has the full sentence results.
You can use CELIO's transcript object to subscribe to these topics.

The messages are JSON strings with the following format:
```javascript
{
  channel: "channel_num",
  speaker: "speaker_name (optional)",
  result: {
    alternatives: [{transcript: "message", confidence: 0.9}],
    final: true,
    keyword_result: {}
  }
}
```
