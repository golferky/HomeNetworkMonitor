import { HttpClient } from 'hap-controller';

const ip = '192.168.1.2';
const port = 51826;
const pincode = '337-46-305';
const deviceId = '001788ffe2c3df0';

console.log('Attempting to pair with Hue bridge via HomeKit...');

const client = new HttpClient(deviceId, ip, port);
client.pairSetup(pincode).then(credentials => {
  console.log('SUCCESS!');
  console.log(JSON.stringify(credentials, null, 2));
}).catch(err => {
  console.error('Failed:', err.message);
});
