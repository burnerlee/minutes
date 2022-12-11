let audioCtx,dest,micAudio,micStream;

const extend = function() { //helper function to merge objects
  let target = arguments[0],
      sources = [].slice.call(arguments, 1);
  for (let i = 0; i < sources.length; ++i) {
    let src = sources[i];
    for (key in src) {
      let val = src[key];
      target[key] = typeof val === "object"
        ? extend(typeof target[key] === "object" ? target[key] : {}, val)
        : val;
    }
  }
  return target;
};

const WORKER_FILE = {
  wav: "WavWorker.js",
  mp3: "Mp3Worker.js"
};

// default configs
const CONFIGS = {
  workerDir: "/workers/",     // worker scripts dir (end with /)
  numChannels: 2,     // number of channels
  encoding: "wav",    // encoding (can be changed at runtime)

  // runtime options
  options: {
    timeLimit: 1200,           // recording time limit (sec)
    encodeAfterRecord: true, // process encoding after recording
    progressInterval: 1000,   // encoding progress report interval (millisec)
    bufferSize: undefined,    // buffer size (use browser default)

    // encoding-specific options
    wav: {
      mimeType: "audio/wav"
    },
    mp3: {
      mimeType: "audio/mpeg",
      bitRate: 192            // (CBR only): bit rate = [64 .. 320]
    }
  }
};

class Recorder {

  constructor(source, configs) { //creates audio context from the source and connects it to the worker
    extend(this, CONFIGS, configs || {});
    this.context = source.context;
    if (this.context.createScriptProcessor == null)
      this.context.createScriptProcessor = this.context.createJavaScriptNode;
    this.input = this.context.createGain();
    source.connect(this.input);
    this.buffer = [];
    this.initWorker();
  }

  isRecording() {
    return this.processor != null;
  }

  setEncoding(encoding) {
    if(!this.isRecording() && this.encoding !== encoding) {
        this.encoding = encoding;
        this.initWorker();
    }
  }

  setOptions(options) {
    if (!this.isRecording()) {
      extend(this.options, options);
      this.worker.postMessage({ command: "options", options: this.options});
    }
  }

  startRecording() {
    if(!this.isRecording()) {
      let numChannels = this.numChannels;
      let buffer = this.buffer;
      let worker = this.worker;
      this.processor = this.context.createScriptProcessor(
        this.options.bufferSize,
        this.numChannels, this.numChannels);
      this.input.connect(this.processor);
      this.processor.connect(this.context.destination);
      this.processor.onaudioprocess = function(event) {
        for (var ch = 0; ch < numChannels; ++ch)
          buffer[ch] = event.inputBuffer.getChannelData(ch);
        worker.postMessage({ command: "record", buffer: buffer });
      };
      this.worker.postMessage({
        command: "start",
        bufferSize: this.processor.bufferSize
      });
      this.startTime = Date.now();
    }
  }

  cancelRecording() {
    if(this.isRecording()) {
      this.input.disconnect();
      this.processor.disconnect();
      // micStream.getTracks().forEach((t) => t.stop());
      // micAudio.disconnect(dest);
      delete this.processor;
      this.worker.postMessage({ command: "cancel" });
    }
  }

  finishRecording() {
    if (this.isRecording()) {
      this.input.disconnect();
      this.processor.disconnect();
      // micStream.getTracks().forEach((t) => t.stop());
      // micAudio.disconnect(dest);
      delete this.processor;
      this.worker.postMessage({ command: "finish" });
    }
  }

  cancelEncoding() {
    if (this.options.encodeAfterRecord)
      if (!this.isRecording()) {
        this.onEncodingCanceled(this);
        this.initWorker();
      }
  }

  initWorker() {
    if (this.worker != null)
      this.worker.terminate();
    this.onEncoderLoading(this, this.encoding);
    this.worker = new Worker(this.workerDir + WORKER_FILE[this.encoding]);
    let _this = this;
    this.worker.onmessage = function(event) {
      let data = event.data;
      switch (data.command) {
        case "loaded":
          _this.onEncoderLoaded(_this, _this.encoding);
          break;
        case "timeout":
          _this.onTimeout(_this);
          break;
        case "progress":
          _this.onEncodingProgress(_this, data.progress);
          break;
        case "complete":
          _this.onComplete(_this, data.blob);
      }
    }
    this.worker.postMessage({
      command: "init",
      config: {
        sampleRate: this.context.sampleRate,
        numChannels: this.numChannels
      },
      options: this.options
    });
  }

  onEncoderLoading(recorder, encoding) {}
  onEncoderLoaded(recorder, encoding) {}
  onTimeout(recorder) {}
  onEncodingProgress(recorder, progress) {}
  onEncodingCanceled(recorder) {}
  onComplete(recorder, blob) {}

}

const audioCapture = (timeLimit, muteTab, format, quality, limitRemoved) => {
  chrome.tabCapture.capture({audio: true}, (stream) => { // sets up stream for capture
    let startTabId; //tab when the capture is started
    let timeout;
    let completeTabID; //tab when the capture is stopped
    let audioURL = null; //resulting object when encoding is completed
    let blobTemp = null;
    chrome.tabs.query({active:true, currentWindow: true}, (tabs) => startTabId = tabs[0].id) //saves start tab
    const liveStream = stream;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(dest);
    let mediaRecorder = new Recorder(source); //initiates the recorder based on the current stream
    mediaRecorder.setEncoding(format); //sets encoding based on options
    if(limitRemoved) { //removes time limit
      mediaRecorder.setOptions({timeLimit: 10800});
    } else {
      mediaRecorder.setOptions({timeLimit: timeLimit/1000});
    }
    if(format === "mp3") {
      mediaRecorder.setOptions({mp3: {bitRate: quality}});
    }
    mediaRecorder.startRecording();

    function onStopCommand(command) { //keypress
      if (command === "stop") {
        stopCapture();
      }
    }
    function onStopClick(request) { //click on popup
      if(request === "stopCapture") {
        stopCapture();
      } else if (request === "cancelCapture") {
        cancelCapture();
      } else if (request.cancelEncodeID) {
        if(request.cancelEncodeID === startTabId && mediaRecorder) {
          mediaRecorder.cancelEncoding();
        }
      }
    }
    chrome.commands.onCommand.addListener(onStopCommand);
    chrome.runtime.onMessage.addListener(onStopClick);
    mediaRecorder.onComplete = (recorder, blob) => {
      audioURL = window.URL.createObjectURL(blob);
      blobTemp = blob;
      if(completeTabID) {
        chrome.tabs.sendMessage(completeTabID, {type: "encodingComplete", audioURL, blob:blobTemp});
      }
      mediaRecorder = null;
    }
    mediaRecorder.onEncodingProgress = (recorder, progress) => {
      if(completeTabID) {
        chrome.tabs.sendMessage(completeTabID, {type: "encodingProgress", progress: progress});
      }
    }

    const stopCapture = function() {
      let endTabId;
      // micAudio.disconnect(dest);
      //check to make sure the current tab is the tab being captured
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        endTabId = tabs[0].id;
        if(mediaRecorder && startTabId === endTabId){
          mediaRecorder.finishRecording();
          chrome.tabs.create({url: "complete.html"}, (tab) => {
            completeTabID = tab.id;
            let completeCallback = () => {
              chrome.tabs.sendMessage(tab.id, {type: "createTab", format: format, audioURL, startID: startTabId, blob:blobTemp});
            }
            setTimeout(completeCallback, 500);
          });
          closeStream(endTabId);
        }
      })
    }

    const cancelCapture = function() {
      // micAudio.disconnect(dest);
      let endTabId;
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        endTabId = tabs[0].id;
        if(mediaRecorder && startTabId === endTabId){
          mediaRecorder.cancelRecording();
          closeStream(endTabId);
        }
      })
    }

//removes the audio context and closes recorder to save memory
    const closeStream = function(endTabId) {
      chrome.commands.onCommand.removeListener(onStopCommand);
      chrome.runtime.onMessage.removeListener(onStopClick);
      mediaRecorder.onTimeout = () => {};
      audioCtx.close();
      liveStream.getAudioTracks()[0].stop();
      // micAudio.disconnect(dest);
      // micStream.getTracks().forEach((t) => t.stop());
      sessionStorage.removeItem(endTabId);
      chrome.runtime.sendMessage({captureStopped: endTabId});
    }

    mediaRecorder.onTimeout = stopCapture;

    if(!muteTab) {
      let audio = new Audio();
      audio.srcObject = liveStream;
      audio.play();
    }
  });
}



//sends reponses to and from the popup menu
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.currentTab && sessionStorage.getItem(request.currentTab)) {
    sendResponse(sessionStorage.getItem(request.currentTab));
  } else if (request.currentTab){
    sendResponse(false);
  } else if (request === "startCapture") {
    startCapture();
  }
});

const startCapture = function() {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    // CODE TO BLOCK CAPTURE ON YOUTUBE, DO NOT REMOVE
    // if(tabs[0].url.toLowerCase().includes("youtube")) {
    //   chrome.tabs.create({url: "error.html"});
    // } else {
      if(!sessionStorage.getItem(tabs[0].id)) {
        sessionStorage.setItem(tabs[0].id, Date.now());
        chrome.storage.sync.get({
          maxTime: 1200000,
          muteTab: false,
          format: "mp3",
          quality: 192,
          limitRemoved: false
        }, (options) => {
          let time = options.maxTime;
          if(time > 1200000) {
            time = 1200000
          }
          audioCtx = new AudioContext();
          dest = audioCtx.createMediaStreamDestination();
          // navigator.mediaDevices.getUserMedia({audio:true}).then((mic) => {
          //   micStream = mic;
          //   micAudio = audioCtx.createMediaStreamSource(micStream);
          //   micAudio.connect(dest);
            audioCapture(time, options.muteTab, options.format, options.quality, options.limitRemoved);
          // });
        });
        chrome.runtime.sendMessage({captureStarted: tabs[0].id, startTime: Date.now()});
      }
    // }
  });
};


// chrome.commands.onCommand.addListener((command) => {
//   if (command === "start") {
//     startCapture();
//   }
// });

let recLength = 0,
    recBuffers = [],
    sampleRate,
    numChannels;

onmessage = function(e) {
    switch (e.data.command) {
        case 'init':
            init(e.data.config);
            break;
        case 'record':
            record(e.data.buffer);
            break;
        case 'exportWAV':
            exportWAV(e.data.type);
            break;
        case 'getBuffer':
            getBuffer();
            break;
        case 'clear':
            clear();
            break;
    }
};

function init(config) {
    sampleRate = config.sampleRate;
    numChannels = config.numChannels;
    initBuffers();
}

function record(inputBuffer) {
    for (var channel = 0; channel < numChannels; channel++) {
        recBuffers[channel].push(inputBuffer[channel]);
    }
    recLength += inputBuffer[0].length;
}

function exportWAV(type) {
    let buffers = [];
    for (let channel = 0; channel < numChannels; channel++) {
        buffers.push(mergeBuffers(recBuffers[channel], recLength));
    }
    let interleaved;
    if (numChannels === 2) {
        interleaved = interleave(buffers[0], buffers[1]);
    } else {
        interleaved = buffers[0];
    }
    let dataview = encodeWAV(interleaved);
    let audioBlob = new Blob([dataview], {type: type});

    this.postMessage({command: 'exportWAV', data: audioBlob});
}

function getBuffer() {
    let buffers = [];
    for (let channel = 0; channel < numChannels; channel++) {
        buffers.push(mergeBuffers(recBuffers[channel], recLength));
    }
    this.postMessage({command: 'getBuffer', data: buffers});
}

function clear() {
    recLength = 0;
    recBuffers = [];
    initBuffers();
}

function initBuffers() {
    for (let channel = 0; channel < numChannels; channel++) {
        recBuffers[channel] = [];
    }
}

function mergeBuffers(recBuffers, recLength) {
    let result = new Float32Array(recLength);
    let offset = 0;
    for (let i = 0; i < recBuffers.length; i++) {
        result.set(recBuffers[i], offset);
        offset += recBuffers[i].length;
    }
    return result;
}

function interleave(inputL, inputR) {
    let length = inputL.length + inputR.length;
    let result = new Float32Array(length);

    let index = 0,
        inputIndex = 0;

    while (index < length) {
        result[index++] = inputL[inputIndex];
        result[index++] = inputR[inputIndex];
        inputIndex++;
    }
    return result;
}

function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, input[i]));
        output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function encodeWAV(samples) {
    let buffer = new ArrayBuffer(44 + samples.length * 2);
    let view = new DataView(buffer);

    /* RIFF identifier */
    writeString(view, 0, 'RIFF');
    /* RIFF chunk length */
    view.setUint32(4, 36 + samples.length * 2, true);
    /* RIFF type */
    writeString(view, 8, 'WAVE');
    /* format chunk identifier */
    writeString(view, 12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw) */
    view.setUint16(20, 1, true);
    /* channel count */
    view.setUint16(22, numChannels, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * 4, true);
    /* block align (channel count * bytes per sample) */
    view.setUint16(32, numChannels * 2, true);
    /* bits per sample */
    view.setUint16(34, 16, true);
    /* data chunk identifier */
    writeString(view, 36, 'data');
    /* data chunk length */
    view.setUint32(40, samples.length * 2, true);

    floatTo16BitPCM(view, 44, samples);

    return view;
}

// ask for user permission when extension is first installed
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason.search(/install/g) === -1) {
    return;
  }

  chrome.tabs.create({
    url: chrome.extension.getURL('welcome.html'),
    active: true,
  });
});
