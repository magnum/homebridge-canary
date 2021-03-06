var request = require('request-promise-native');
var Cookie = require('tough-cookie').Cookie;
var Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-canary", "Canary", Canary, true);
}

function Canary(log, config, api) {
  this.log = log;
  this.api = api;
  this.name = config['name'];
  this.serialNumber = config['serial'];
  this.username = config['username'];
  this.password = config['password'];
  this.session = config['session'];
  this.pollingInterval = config['pollingInterval'] * 1000;
  this.cached = {};

  // Log in if necessary
  if (!this.session) {
    this.login()
      .catch((err) => this.log('Error on login: ' + err))
      .then((res) => { this.setSession(res); this.update() });
  }

  // Run periodically in background
  setTimeout(() => this.poll(), this.pollingInterval);
}

Canary.prototype.getStateTemperature = function(callback) {
  this.getSensor('temperature', callback);
}

Canary.prototype.getStateHumidity = function(callback) {
  this.getSensor('humidity', callback);
}

Canary.prototype.getStateAirQuality = function(callback) {
  this.getSensor('air_quality', (err, val) => {
    let quality;
    if (val <= 0.3) {
      quality = 1;
    } else if (val <= 0.4) {
      quality = 2;
    } else if (val <= 0.5) {
      quality = 3;
    } else if (val <= 0.6) {
      quality = 4;
    } else {
      quality = 5;
    }
    callback(err, quality);
  });
}

Canary.prototype.poll = function() {
  this.update();
  setTimeout(() => this.poll(), this.pollingInterval);
}

Canary.prototype.getSensor = function(sensor, callback) {
  if (!this.cached[sensor]) {
    callback('Not initialized');
    return;
  }

  callback(null, this.cached[sensor]);
}

Canary.prototype.update = function() {
  if (!this.session) {
    this.log('No session, skipping update');
    return;
  }

  this.log('Updating sensor values');

  this.updateSensorValues()
    .catch((err) => this.log('Error on update: ' + err));
}

Canary.prototype.updateSensorValues = async function() {
  let id = await this.deviceId();
  let sensors = await this.readings(id);

  for (var i in sensors) {
    let type = sensors[i].sensor_type;
    let value = sensors[i].value;
    this.cached[type] = value;

    this.log(`Updated ${type} value: ${value}`);
  }

  return Promise.resolve();
}

Canary.prototype.readings = async function(deviceId) {
  return request.get({
    json: true,
    uri: this.endpoint(`/api/readings?deviceId=${deviceId}&type=canary`),
    headers: {
      'Authorization': 'Bearer ' + this.session,
    }
  })
}

Canary.prototype.deviceId = async function() {
  let locations = await request.get({
    json: true,
    uri: this.endpoint('/api/locations'),
    headers: {
      'Authorization': 'Bearer ' + this.session,
    }
  });

  for (var i in locations) {
    for (var j in locations[i].devices) {
      let device = locations[i].devices[j];
      if (device.serial_number == this.serialNumber) {
        return Promise.resolve(device.id);
      }
    }
  }

  return Promise.reject('Device with serial ' + this.serialNumber + ' not found');
}

Canary.prototype.setSession = function(session) {
  this.session = session;
}

Canary.prototype.getServices = function() {
  let info = new Service.AccessoryInformation();

  info
    .setCharacteristic(Characteristic.Manufacturer, 'Canary')
    .setCharacteristic(Characteristic.Model, 'Homebridge')
    .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);

  let temperature = new Service.TemperatureSensor(this.name + ' Temperature');

  temperature
    .getCharacteristic(Characteristic.CurrentTemperature)
    .on('get', this.getStateTemperature.bind(this));

  let humidity = new Service.HumiditySensor(this.name + ' Humidity');

  humidity
    .getCharacteristic(Characteristic.CurrentRelativeHumidity)
    .on('get', this.getStateHumidity.bind(this));

  let airq = new Service.AirQualitySensor(this.name + ' Air Quality');

  airq
    .getCharacteristic(Characteristic.AirQuality)
    .on('get', this.getStateAirQuality.bind(this));

  return [info, temperature, humidity, airq];
}

Canary.prototype.login = async function() {
  let req = request.defaults({
    jar: true,
    resolveWithFullResponse: true,
  });

  let response = await req.get(this.endpoint('/login'));
  let cookies = response.headers['set-cookie'];

  let xsrfToken;
  for (var i in cookies) {
    let cookie = Cookie.parse(cookies[i]);
    if (cookie && cookie.key == 'XSRF-TOKEN') {
      xsrfToken = cookie.value;
    }
  }

  if (!xsrfToken) {
    return Promise.reject('Unable to log in, no XSRF token found?')
  }

  response = await req.post({
    json: true,
    uri: this.endpoint('/api/auth/login'),
    headers: {
      'X-XSRF-TOKEN': xsrfToken,
    },
    body: {
      username: this.username,
      password: this.password,
    },
  });

  return Promise.resolve(response.body['access_token']);
}

Canary.prototype.endpoint = function(path) {
  return 'https://my.canary.is' + path;
}
