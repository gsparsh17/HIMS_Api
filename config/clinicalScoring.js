/**
 * Hospital clinical scoring configuration.
 * Clinical leadership must approve threshold values before production activation.
 * The server always calculates scores from raw readings; it never trusts a client total.
 */
const DEFAULT_TIMEZONE = process.env.HOSPITAL_TIMEZONE || 'Asia/Kolkata';

const EWS_CONFIG = {
  version: process.env.EWS_CONFIG_VERSION || 'ews-2-hospital-config-v1',
  approved: process.env.EWS_CONFIG_APPROVED === 'true',
  escalationTotal: Number(process.env.EWS_ESCALATION_TOTAL || 4),
  escalationParameterScore: Number(process.env.EWS_ESCALATION_PARAMETER_SCORE || 3),

  score({ respiratoryRate, spo2, pulse, systolicBP, temperature, temperatureUnit, consciousnessResponse, noUrineOverSixHours }) {
    const band = (value, rules) => {
      if (!Number.isFinite(Number(value))) return 0;
      for (const rule of rules) {
        if (rule.when(Number(value))) {
          return rule.score;
        }
      }
      return 0;
    };

    // Convert temperature to Fahrenheit if needed
    let temperatureF = temperature;
    if (temperatureUnit === 'Celsius') {
      temperatureF = (temperature * 9 / 5) + 32;
    }

    const consciousness = ['Voice', 'Pain', 'Unresponsive', 'Confusion'].includes(consciousnessResponse) ? 3 : 0;

    return {
      respiratoryRate: band(respiratoryRate, [
        { when: v => v <= 8 || v >= 25, score: 3 },
        { when: v => v <= 11 || v >= 21, score: 1 }
      ]),

      spo2: band(spo2, [
        { when: v => v <= 91, score: 3 },
        { when: v => v <= 93, score: 2 },
        { when: v => v <= 95, score: 1 }
      ]),

      heartRate: band(pulse, [
        { when: v => v <= 40 || v >= 131, score: 3 },
        { when: v => v <= 50 || v >= 111, score: 1 }
      ]),

      systolicBP: band(systolicBP, [
        { when: v => v <= 90 || v >= 220, score: 3 },
        { when: v => v <= 100, score: 2 },
        { when: v => v <= 110, score: 1 }
      ]),

      temperature: band(temperatureF, [
        { when: v => v <= 95 || v >= 102.2, score: 2 },
        { when: v => v >= 100.4, score: 1 }
      ]),

      consciousness,
      urineSelfVoiding: noUrineOverSixHours ? 3 : 0,
      urineMeasured: 0
    };
  }
};

module.exports = { DEFAULT_TIMEZONE, EWS_CONFIG };