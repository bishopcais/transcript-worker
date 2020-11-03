# Transcript-Worker

## Installation
You will need to install [ffmpeg](https://www.ffmpeg.org/) for the transcript-worker to function.
This handles getting input across many different channels as well as deal with setting sound thresholds
and such. To get it, for macOS you should use [homebrew](https://brew.sh) and for Linux use your distro's
package manager. Alternatively for those platforms, and for Windows generally, you can directly
[download](https://www.ffmpeg.org/download.html) the necessary binaries and put them somewhere on your path.

Then, you need to get the [STT Credentials](#STT_Credentials) and then do:

```bash
npm install
cp cog-sample.json cog.json
```

## Usage

```bash
node transcribe.js
```

You can go to http://localhost:4545 to view a web UI that allows you to on-the-fly configure channels
and view their current status.

## Configuration

To run this worker, you will need a cog.json file to handle its configuration.
Discussed below are the various elements that go into it.

Before continuing, you should determine the device that you want to use for the worker.
To find out device names:
On Windows, use: `ffmpeg -list_devices true -f dshow -i dummy`.
On Mac, use: `ffmpeg -list_devices true -f avfoundation -i dummy`.
On Linux, use: `arecord -L`.
For Mac and Linux, you can probably just use **default**, and choose the device through the system dialog. On Windows,
you may need to take the name of the device from the command above and set the `device` key for a channel to
point to that device, for example:

```js
{
  // other settings
  "transcribe": {
    // other transcribe settings
    "channels": [
      {
        "device": "Microphone (2- USB PnP Audio Device)"
        // other channel settings
      }
    ]
  }
}
```

### RabbitMQ

If you wish to utilize RabbitMQ for the worker, you must specify the following:

```json
{
  "rabbit": true
}
```

If this is not specified, the transcript worker, will just write each incoming transcription to
the console, and nothing else. Refer to documentation for
[@cisl/io](https://github.com/cislrpi/io) for further configuration details. See
below for the RabbitMQ topics and payloads for this worker.

### STT Credentials

You must input the credentials of [Watson Speech-to-Text service](https://www.ibm.com/watson/services/speech-to-text/),
utilizing the `ibm-credentials.env` file for the service. See
[node-sdk#getting-credentials](https://github.com/watson-developer-cloud/node-sdk#getting-credentials)
for details on how to get the file and details about it.

### transcript-worker configuration

Configuration for running the `transcript-worker` happens under the `transcribe` key in the
`cog.json` file. Many of the values can be omitted, and will be instantiated with the defaults
described below.

#### Defaults

Next, you will need to configure the default details of the service:

```json
{
  "transcribe": {
    "default_driver": "ffmpeg",
    "default_device": "default",
    "default_language": "en-US",
    "default_model": "broad",
  }
}
```

This provides default settings for each channel you specify (see below). The device
should be set using the instructions above. The language should be the IETF format with
ISO 3166-1 country code. The model should either be "broad" or "narrow". You can go to
https://console.bluemix.net/docs/services/speech-to-text/models.html#models to see the
full list of support languages and models.

The `driver` can be either `ffmpeg` (to allow piping from `ffmpeg` onto that channel) or
`fake` (only allow typing in inputs from web console).

Note: Leaving these out of the configuration will use the values shown above.

#### Channel Configuration

Channel configuration is handled by a list of objects as shown below:

```json
{
  "transcribe": {
      "channels": [
      {
        "device": "device name",
        "language": "en-US",
        "model": "broad"
      },
      {
        "_comment": "use default settings",
        "driver": "fake"
      }
    ]
  }
}
```
The first channel has all values explicitly defined with the second channel
using the defaults (see above). You can specify as many or as few of the properties
for a channel as you want.

Note: If you don't include the "channels" key, then the system will default to one
channel with the default settings.

#### Misc

```json
{
  "buffer_size": 512000,
  "speaker_id_duration": 30000,
  "max_alternatives": 3,
}
```

The `buffer_size` specifies how big of a stored buffer each channel will have for the incoming binary
sound buffer from ffmpeg, allowing one to fetch this for later analysis as requested.

The `speaker_id_duration` is how long should a channel save a speaker id once specified. If set to
`false`, then speaker ids will never be removed.

The `max_alternatives` sets how many possible alternative transcriptions is returned by the Watson service.

Note: Leaving these out will use the above default values.

## RabbitMQ

Assuming you've configured the worker to use RabbitMQ as specified above, the worker
will publish its results to RabbitMQ as well as allow you to configure it.

### Publishing

The transcript-worker as it receives results publishes to two topics in RabbitMQ:

* transcript.result.interim
* transcript.result.final

The first topic is broadcasted by the worker as the speech to text service attempts
to figure out what was said. This is useful for UI elements to show the user that
the system is listening to them. The second topic is the final transcription
returned by the service and should be taken as what the user said to the system.

Both of these topics have the following message structure:

```json
{
  "worker_id": "transcript-worker",
  "message_id": "5a5b5940-1f33-11e9-b7f9-23b47ef98a1b",
  "timestamp": "2019-01-23T17:21:43.124Z",
  "channel_idx": 0,
  "transcript": "yeah range",
  "total_time": 0.97,
  "result": {
    "alternatives": [
      {
        "timestamps": [
          [
            "yeah",
            2.87,
            3.21
          ],
          [
            "range",
            3.43,
            3.84
          ]
        ],
        "confidence": 0.648,
        "transcript": "yeah range"
      }
    ],
    "final": true
  }
}
```

### Receiving

The transcript worker listens for a range of commands to change how it's operating
or to request some sort of data on the next input. These commands are:

* transcript.command.tag_channel: `{"channel_idx": number, "speaker": string}`
* transcript.command.switch_language: `{"channel_idx": number|null, "language": string}`
* transcript.command.pause: `{"channel_idx": number|null}`
* transcript.command.unpause: `{"channel_idx": number|null}`
* transcript.command.extract_pitchtone `{"channel_idx": number}`
* transcript.command.start_publish `{}`
* transcript.command.stop_publish `{}`

Additionally, the following legacy topics are supported:

* switchModel.transcript.command: `"language_model_name"`
* switchAcousticModel.transcript.command: `"acoustic_model_name"`
* controlAudioCapture.transcript.command: `{"channelIndex": number|null, "command": "pause"|"unpause"}`
* rpc-transcript-|config.id|-tagChannel (__RPC Queue__): `{"channelIndex": number, "speaker": string}`

__NOTE__: You can use `channel_idx` and `channelIndex` interchangeably, 
however, it is recommended to move to `channel_idx` as `channelIndex` will be
removed at some point.

### Integration with Learning Assistant

This application does not directly interact with the [Learning Assistant](https://internal.cisl.rpi.edu/la/),
but rather exposes a binary buffer along the `transcript.pitchtone.audio` topic (after extraction
was requested for a channel using `transcript.command.extract_pitchtone`). After requesting an extraction, the
next spoken word/phrase that is transcribed will be sent, regardless of the usage of a wake-up word or otherwise.

Below is an example of code that can be used to interface with the transcript-worker and Learning Assistant:

```javascript
const io = require('@cisl/io');
const wav = require('wav');
const fs = require('fs');
const fetch = require('node-fetch');
const FormData = require('form-data');

io.rabbit.onTopic('transcript.pitchtone.audio', (response) => {
  const file_name = `output-${io.generateUuid()}.wav`;
  var save_wav = new wav.FileWriter(file_name, {
    channels: 1,
    sampleRate: 16000,
    bitDepth: 16
  });

  save_wav.on('finish', () => {
    const form = new FormData();
    form.append('format', 'json');
    form.append('sample_rate', '16000');
    form.append('file', fs.createReadStream(file_name));
    form.append('word', '校内');

    fetch('https://internal.cisl.rpi.edu/la/upload', {
      method: 'POST',
      body: form
    })
      .then(res => res.json())
      .then(json => {
        fs.unlinkSync(file_name);
        console.log(json)
      });
  });

  save_wav.write(response.content);
  save_wav.end();
});

io.rabbit.publishTopic('transcript.command.extract_pitchtone', {channel_idx: 0});
```

where the output to the console will be:

```json
{
  "filename": "<file_name>"
}
```

which corresponds to `https://internal.cisl.rpi.edu/la/renders/<file_name>`, for example:

```json
{
  "filename": "1570115937_855945.webm"
}
```

corresponds to https://internal.cisl.rpi.edu/la/renders/1570115937_855945.webm.
