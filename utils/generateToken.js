const jwt = require('jsonwebtoken');

const generateToken = (id, role, additionalClaims = {}) => {
  return jwt.sign({ id, role, ...additionalClaims }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

module.exports = generateToken;
