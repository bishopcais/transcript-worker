# Transcript-Worker

## Requirements
**ffmpeg**

To run this, you need to have a cog.json file in your package directory.
The cog.json file needs to have at least the following fields:
```json
{
  "rabbitMQ": {
    "url": "amqp url",
    "exchange": "exchange name"
  },
  "STT": {
    "username": "Your Watson STT username",
    "password": "Your Password"
  },
  "device": "prefix to the published message topic",
  "models": {
    "generic": "en-US_BroadbandModel",
  }
}
```

The messages are published to RabbitMQ with the topic keys device.interim.transcript and device.final.transcript.  The "interim" channel only contains intermediate results while the "final" channel only has the full sentence results.  You can use CELIO's transcript object to subscribe to these channels.

The messages are JSON strings with the following format:
```javascript
{
  channel: "channel_num",
  result: {
    alternatives: [{transcript: "message", confidence: 0.9}],
    final: true,
    keyword_result: {}
  },
  time_captured: unix_time_in_ms
}
```
