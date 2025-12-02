const fs = require('fs');
const key = fs.readFileSync('./zap-shift-5fea2-firebase-adminsdk-fbsvc-2058c83616.json', 'utf8')
const base64 = Buffer.from(key).toString('base64')
console.log(base64)