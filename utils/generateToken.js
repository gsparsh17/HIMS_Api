const jwt = require('jsonwebtoken');

const generateToken = (idOrUser, roleOrClaims, additionalClaims = {}) => {
  let id;
  let role;
  let claims;

  if (idOrUser && typeof idOrUser === 'object') {
    id = idOrUser._id || idOrUser.id;
    role = idOrUser.role;
    claims = {
      securityVersion: Number(idOrUser.securityVersion || 0),
      ...(roleOrClaims && typeof roleOrClaims === 'object' ? roleOrClaims : {})
    };
  } else {
    id = idOrUser;
    role = roleOrClaims;
    claims = additionalClaims || {};
  }

  return jwt.sign({ id, role, ...claims }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d'
  });
};

module.exports = generateToken;
