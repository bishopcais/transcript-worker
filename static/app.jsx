'use strict';


class Channel extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      transcript: ''
    }

    this.handleChange = this.handleChange.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handlePause = this.handlePause.bind(this);

    this.handleSubmit = this.handleSubmit.bind(this);

    this.handleTranscriptChange = this.handleTranscriptChange.bind(this);
    this.handleTranscriptSubmit = this.handleTranscriptSubmit.bind(this);
  }

  handleChange(event) {
    event.preventDefault();
    const target = event.target;
    this.props.onChange(this.props.idx, target.name, target.value).then(() => {
      if (target.tagName.toLowerCase() === 'select') {
        this.props.onSubmit(this.props.idx);
      }
    });
  }

  handleSubmit(event) {
    event.preventDefault();
    this.props.onSubmit(this.props.idx);
  }

  handleTranscriptChange(event) {
    event.preventDefault();
    this.setState({transcript: event.target.value});
  }

  handleTranscriptSubmit(event) {
    event.preventDefault();
    this.props.onTranscriptSubmit(this.props.idx, this.state.transcript);
  }

  handlePause(event) {
    event.preventDefault();
    this.props.onChange(this.props.idx, 'paused', !this.props.data.paused).then(() => {
      this.props.onSubmit(this.props.idx);
    });
  }

  handleBlur(event) {
    event.preventDefault();
    this.props.onSubmit(this.props.idx);
  }

  renderTranscript() {
    return this.props.data.transcript.map((transcript, idx) => {
      return <div key={idx}>[{transcript.timestamp}] {transcript.transcript}</div>;
    });
  }

  render() {
    return (
      <div className='channel'>
        <div className='title'>Channel {this.props.data.idx}</div>
        <form onSubmit={this.handleSubmit}>
          <div className='channel-info'>
            <div className='channel-info-row'>
              <div className='channel-info-column'>Index</div>
              <div className='channel-info-column'>{this.props.data.idx}</div>
            </div>
            <div className='channel-info-row'>
              <div className='channel-info-column'>Driver</div>
              <div className='channel-info-column'>{this.props.data.driver}</div>
            </div>
            <div className='channel-info-row'>
              <div className='channel-info-column'>Device</div>
              <div className='channel-info-column'>{this.props.data.device}</div>
            </div>
            <div className='channel-info-row'>
              <div className='channel-info-column'>Speaker</div>
              <div className='channel-info-column'>
                <input
                  name='speaker'
                  type='input'
                  onChange={this.handleChange}
                  onBlur={this.handleBlur}
                  value={this.props.data.speaker || ''}
                />
              </div>
            </div>
            <div className='channel-info-row'>
              <div className='channel-info-column'>Language</div>
              <div className='channel-info-column'>
                <select
                  name='language'
                  onChange={this.handleChange}
                  value={this.props.data.language}
                >
                  {this.props.languages.map((language) => <option key={language}>{language}</option>)}
                </select>
              </div>
            </div>
            <div className='channel-info-row'>
              <div className='channel-info-column'>Model</div>
              <div className='channel-info-column'>
              <select
                name='model'
                onChange={this.handleChange}
                value={this.props.data.model}
              >
                  <option>broad</option>
                  <option>narrow</option>
                </select>
              </div>
            </div>
            <div className='channel-info-row'>
              <div className='channel-info-column'>Paused</div>
              <div className='channel-info-column rs'>
                <a onClick={this.handlePause}><i className={'fas fa-' + (this.props.data.paused ? 'play' : 'pause')} /></a>
              </div>
            </div>
          </div>

        </form>
        <br /><br />
        <form onSubmit={this.handleTranscriptSubmit}>
          Send Message: <input type='input' value={this.state.transcript} onChange={this.handleTranscriptChange} /> <button>Send</button>
        </form>
        <br />
        <div className='transcript'>
            Previous:
            <div>
              {this.renderTranscript()}
            </div>
        </div>
      </div>
    );
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      socket: null,
      channels: [],
      languages: []
    }

    this.handleFieldChange = this.handleFieldChange.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleTranscriptSubmit = this.handleTranscriptSubmit.bind(this);
  }

  componentDidMount() {
    this.connect();
  }

  connect() {
    console.log(`connecting...`);
    const socket = new WebSocket(location.href.replace('http', 'ws'));

    socket.onopen = () => {
      this.setState({socket: socket});
      socket.send(JSON.stringify({type: 'get_channels'}));
      socket.send(JSON.stringify({type: 'get_languages'}));
    }

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'channels') {
        this.setState({channels: msg.data});
      }
      else if (msg.type === 'languages') {
        this.setState({languages: msg.data});
      }
      else if (msg.type === 'channel') {
        // create a copy of the object
        const channels = JSON.parse(JSON.stringify(this.state.channels));
        channels[msg.data.idx] = msg.data;
        this.setState({channels: channels});
      }
      else if (msg.type === 'transcript') {
        const channels = JSON.parse(JSON.stringify(this.state.channels));
        if (!channels[msg.data.idx].transcript) {
          channels[msg.data.idx].transcript = [];
        }
        channels[msg.data.idx].transcript.unshift({
          transcript: msg.data.transcript,
          timestamp: msg.data.timestamp
        });
        this.setState({channels: channels});
      }
      else if (msg.type === 'error') {
        console.error(msg.message);
      }
    }

    socket.onerror = (evt) => {
      if (socket.readyState === 1) {
        console.log(`ws normal error: ${evt.type}`);
      }
    }

    socket.onclose = (evt) => {
      if (evt.code !== 301) {
        console.log(`[WARN] socket closed, trying again in 1000ms`);
        setTimeout(this.connect, 1000);
      }
    }
  }

  handleSubmit(idx) {
    this.state.socket.send(JSON.stringify({type: 'save_channel', data: this.state.channels[idx]}));
  }

  handleTranscriptSubmit(idx, message) {
    this.state.socket.send(JSON.stringify({
      type: 'transcript',
      data: {
        idx: idx,
        transcript: message
      }
    }));
  }

  handleFieldChange(idx, field, value) {
    const channels = JSON.parse(JSON.stringify(this.state.channels));
    channels[idx][field] = value;
    return new Promise((resolve) => {
      this.setState({channels: channels}, () => {
        resolve();
      });
    });
  }

  render() {
    return this.state.channels.map((channel) => {
      return (
        <Channel
          key={channel.idx}
          idx={channel.idx}
          data={channel}
          languages={this.state.languages}
          onChange={this.handleFieldChange}
          onSubmit={this.handleSubmit}
          onTranscriptSubmit={this.handleTranscriptSubmit}
        />
      )
    });
  }
}


ReactDOM.render(<App />, document.getElementById('root'));
