# Transcript-Worker

## Requirements
You must have **ffmpeg** installed.
On a mac, you can use `brew install ffmpeg --with-opus --with-ffplay`.

## Configuration
To run this worker, you will need a cog.json file to handle its configuration.
Discussed below are the various elements that go into it.

Before continuing, you should determine the device that you want to use for the worker.
To find out device names:
On Windows, use: `ffmpeg -list_devices true -f dshow -i dummy`.
On Mac, use: `ffmpeg -list_devices true -f avfoundation -i dummy`.
On Linux, use: `arecord -L`.
For Mac and Linux, you can also just use **default**, and choose the device from the system dialog.

#### RabbitMQ
If you wish to utilize RabbitMQ for the worker, you must specify the following:
```json
{
  "mq": true
}
```
If this is not specified, the transcript worker, will just write each incoming transcription to
the console, and nothing else. Refer to documentation for 
[CelIO](https://internal.cisl.rpi/code/libraries/celio) for further configuration details. See
below for the RabbitMQ topics and payloads for this worker.

#### STT Credentials
You must input the credentials of 
[Watson Speech-to-Text service](https://www.ibm.com/watson/services/speech-to-text/).
Once you've gotten the API key (or username/password if using an older instance), you
will need to add an "STT" section to the cog.json as follows:
```json
{
  "STT": {
    "username": "Your Watson STT username",
    "password": "Your Password",
    "version": "v1"
  }
}
```
Note: If using an API key, then the "username" field will just be `apikey`.

#### Defaults
Next, you will need to configure the default details of the service:
```json
{
  "default_device": "default",
  "default_language": "en-US",
  "default_model": "broad",
}
```
This provides default settings for each channel you specify (see below). The device
should be set using the instructions above. The language should be the IETF format with
ISO 3166-1 country code. The model should either be "broad" or "narrow". You can go to
https://console.bluemix.net/docs/services/speech-to-text/models.html#models to see the
full list of support languages and models.

Note: Leaving these out of the configuration will use the values shown above.

#### Channel Configuration
Channel configuration is handled by a list of objects as shown below:
```json
{
  "channels": [
    {
      "idx": "0",
      "device": "device name",
      "language": "en-US",
      "model": "broad"
    },
    {
      "_comment": "use default settings"
    }
  ]
}
```
The first channel has all values explicitly defined with the second channel
using the defaults (see above). You can specify as many or as few of the properties
for a channel as you want. The idx, if not defined, will be its idx in the list of
channels.

Note: If you don't include the "channels" key, then the system will default to one
channel with the above default settings.

#### Misc
```json
{
  "buffer_size": 1000,
  "speaker_id_duration": 30000
}
```
The `buffer_size` specifies how big of a stored buffer each channel will have for the incoming sound
from ffmpeg, allowing one to fetch this for later analysis as requested.

The `speaker_id_duration` is how long should a channel save a speaker id once specified. If set to
`false`, then speaker ids will never be removed.

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
* transcript.command.switch_language
* transcript.command.pause
* transcript.command.unpause
* transcript.command.extract_pitchtone
* transcript.command.tag_channel
* transcript.command.start_publish
* transcript.command.stop_publish

The first three commands accept a `channel_idx` parameter to specify a specific channel
to operate on, else it will run the command on all channels. The middle two commands
(`extract_pitchtone` and `tag_channel`) require a `channel_idx` parameter.

`switch_language` requires a `language` parameter.
`tag_channel` requires a `speaker` parameter.
