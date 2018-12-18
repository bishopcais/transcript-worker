module.exports.last = (array) => {
  const length = array === null ? 0 : array.length;
  return length ? array[length - 1] : undefined;
};

module.exports.getDeviceInfo = (device_name) => {
  let device_interface, device;
  switch (process.platform) {
    case 'darwin':
      device_interface = 'avfoundation';
      device = `none:${device_name}`;
      break;
    case 'win32':
      device_interface = 'dshow';
      device = `audio=${device_name}`;
      break;
    default:
      device_interface = 'alsa';
      device = device_name;
      break;
  }
  return {
    interface: device_interface,
    device: device
  };
};
