const spawn = require('child_process').spawn
const CELIO = require('celio')
const winston = require('winston')
const SpeechToTextV1 = require('watson-developer-cloud/speech-to-text/v1')
const stream = require('stream')
const fs = require('fs')
const RawIPC = require('node-ipc').IPC

if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs')
}

const logger = new (winston.Logger)({
    transports: [
        new winston.transports.File({
            level: 'info',
            colorize: false,
            timestamp: () => new Date().toLocaleString('en-us', { timeZoneName: 'short' }),
            filename: 'logs/all-logs.log',
            handleExceptions: true,
            maxsize: 5242880 // 5MB
        }),
        new winston.transports.Console({
            level: 'info',
            handleExceptions: true,
            json: false,
            colorize: true
        })
    ]
})

const io = new CELIO()
io.config.required(['STT:username', 'STT:password', 'device'])
io.config.defaults({
    'models': {},
    'channels': ['far'],
    'id': io.generateUUID()
})

const channelTypes = io.config.get('channels')
logger.info(`Transcribing ${channelTypes.length} channels.`)

const channels = []
const models = io.config.get('models')
let currentModel = 'generic'
const speakerIDDuration = 5 * 60000 // 5 min

let currentKeywords
io.store.getSet('transcript:keywords').then(keywords => (currentKeywords = keywords))
io.store.onChange('transcript:keywords', () => {
    io.store.getSet('transcript:keywords').then(keywords => {
        currentKeywords = keywords
        logger.info('New keywords', currentKeywords)
        delayedRestart()
    })
})

let currentKeywordsThreshold = 0.01

const speech_to_text = new SpeechToTextV1(io.config.get('STT'))

let deviceInterface
let device
let publish = true

switch (process.platform) {
    case 'darwin':
        deviceInterface = 'avfoundation'
        device = `none:${io.config.get('device')}`
        break
    case 'win32':
        deviceInterface = 'dshow'
        device = `audio=${io.config.get('device')}`
        break
    default:
        deviceInterface = 'alsa'
        device = `${io.config.get('device')}`
        break
}

io.onTopic('switchModel.transcript.command', msg => {
    const model = msg.toString()
    if (!models[model]) {
        logger.info(`Cannot find the ${model} model. Not switching.`)
    } else {
        logger.info(`Switching to the ${model} model.`)

        currentModel = model
        delayedRestart()
    }
})

io.onTopic('stopPublishing.transcript.command', () => {
    logger.info('Stop publishing transcripts.')
    publish = false
})

io.doCall(`rpc-transcript-${io.config.get('id')}-tagChannel`, (request, reply) => {
    const input = JSON.parse(request.content.toString())
    if (channels.length > input.channelIndex) {
        logger.info(`Tagging channel ${input.channelIndex} with name: ${input.speaker}`)
        channels[input.channelIndex].speaker = input.speaker
        reply('done')
    } else {
        reply('ignored')
    }
})

let restarting = false
function delayedRestart() {
    restarting = true
    stopCapture()

    // Restart capturing after 2 seconds.
    // I can't restart transcribing immediately, because I have to wait
    // the previous transcribe sessions to close, otherwise, the server will
    // reject my connections.
    setTimeout(() => {
        startCapture()
    }, 2000)
};

class IPCInputStream extends stream.Readable {
    constructor(options) {
        super(options)
        this.ipc = options.ipc

        const self = this
        options.ipc.serve()
        options.ipc.server.on('data', (data, socket) => {
            self.push(data)
        })
        options.ipc.server.on('disconnect', (data, socket) => {
            self.push(null)
        })

        this.started = false
    }

    _read() {
        if (!this.started) {
            this.ipc.server.start()
            this.started = true
        }
    }
}

function startCapture() {
    for (let i = 0; i < channelTypes.length; i++) {
        let s, p

        if (channelTypes[i] !== 'none') {
            if (io.config.get('device') !== 'IPC') {
                p = spawn('ffmpeg', [
                    '-v', 'error',
                    '-f', deviceInterface,
                    '-i', device,
                    '-map_channel', `0.0.${i}`,
                    '-acodec', 'pcm_s16le', '-ar', '16000',
                    '-f', 'wav', '-'])

                p.stderr.on('data', data => {
                    logger.error(data.toString())
                    process.exit(1)
                })

                s = p.stdout
            } else {
                const ipc = new RawIPC()
                ipc.config.rawBuffer = true
                ipc.config.appspace = 'beam-'
                ipc.config.id = 'transcript-' + i
                ipc.config.encoding = 'hex'
                s = new IPCInputStream({ ipc })
            }

            if (channelTypes[i] === 'far') {
                let paused = false

                io.speaker.onBeginSpeak(() => {
                    logger.info(`Pausing channel ${i}`)
                    paused = true
                })

                io.speaker.onEndSpeak(() => {
                    logger.info(`Resuming channel ${i}`)
                    paused = false
                })

                const pausable = new stream.Transform()
                pausable._transform = function (chunk, encoding, callback) {
                    if (!paused) {
                        this.push(chunk)
                    }
                    callback()
                }

                s = s.pipe(pausable)
            }
        }

        if (channels[i]) {
            channels[i].process = p
            channels[i].stream = s
            channels[i].lastMessageTimeStamp = new Date()
        } else {
            channels.push({ process: p, stream: s })
        }
    }

    transcribe()
}

function stopCapture() {
    logger.info('Stopping all channels.')
    for (let i = 0; i < channelTypes.length; i++) {
        if (channels[i].process) {
            channels[i].process.kill()
            channels[i].process = null
        }
        channels[i].stream = null
    }
}

function transcribe() {
    logger.info(`Starting all channels with the ${currentModel} model.`)

    for (let i = 0; i < channelTypes.length; i++) {
        if (channelTypes[i] === 'none') {
            continue
        }

        const params = {
            content_type: `audio/l16; rate=16000; channels=1`,
            inactivity_timeout: -1,
            smart_formatting: true,
            customization_id: io.config.get('STT:customization_id'),
            interim_results: true
        }
        if (models[currentModel]) {
            params['customization-local-path'] = models[currentModel]
        }
        if (currentKeywords && currentKeywords.length > 0) {
            params.keywords = currentKeywords
            params.keywords_threshold = currentKeywordsThreshold
        }
        const sttStream = speech_to_text.createRecognizeStream(params)

        sttStream.on('error', (err) => {
            if (!restarting) {
                if (err.message) {
                    logger.error(err.message)
                    logger.info('An error occurred. Restarting capturing after 1 second.')
                    delayedRestart()
                } else {
                    logger.error('Cannot connect to the STT server.')
                    process.exit(1)
                }
            }
        })

        const textStream = channels[i].stream.pipe(sttStream)

        textStream.setEncoding('utf8')
        textStream.on('results', input => {
            const result = input.results[0]

            if (result && publish) {
                // See if we should clear speaker name
                if (channels[i].speaker && (new Date() - channels[i].lastMessageTimeStamp > speakerIDDuration)) {
                    logger.info(`Clear tag for channel ${i}.`)
                    channels[i].speaker = undefined
                }

                const msg = {
                    workerID: io.config.get('id'),
                    channelIndex: i,
                    result: result,
                    speaker: channels[i].speaker
                }

                if (result.final) {
                    logger.info(JSON.stringify(msg))
                    channels[i].lastMessageTimeStamp = new Date()
                }

                io.transcript.publish(channelTypes[i], result.final, msg)
            }

            if (!publish) {
                const t = result.alternatives[0].transcript
                if (t.indexOf('start listen') > -1 || t.indexOf('resume listen') > -1 || t.indexOf('begin listen') > -1) {
                    logger.info('Resume listening.')
                    publish = true
                }
            }
        })
    }
}

startCapture()

process.stdin.resume()// so the program will not close instantly

function exitHandler(options, err) {
    if (options.cleanup) stopCapture()
    if (err) console.log(err.stack)
    if (options.exit) process.exit()
}

// do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }))

// catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }))
process.on('SIGTERM', exitHandler.bind(null, { exit: true }))

// catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit: true }))
