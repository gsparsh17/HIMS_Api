// Run this as a separate script or in your Node.js console
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

async function createDemoUser() {
  const hashedPassword = await bcrypt.hash('demo123', 10);
  
  const demoUser = {
    name: "Demo Admin",
    email: "demo@gmail.com",
    password: hashedPassword,
    role: "demo",
    is_active: true
  };
  
  // In MongoDB shell, you would use the hashed password value
  console.log('Use this command in MongoDB shell:');
  console.log(`db.users.insertOne(${JSON.stringify({
    ...demoUser,
    createdAt: new Date(),
    updatedAt: new Date()
  }, null, 2)})`);
}

createDemoUser();

// db.users.insertOne({
//   "name": "Demo Admin",
//   "email": "demo@gmail.com",
//   "password": "$2a$10$segJM2pE7ojNPtHdwhOY3ebbuZB1unJ7tqrz3dI7zizTSlZwcsU5a",
//   "role": "demo",
//   "is_active": true,
//   "createdAt": "2026-03-10T14:30:27.834Z",
//   "updatedAt": "2026-03-10T14:30:27.834Z"
// })