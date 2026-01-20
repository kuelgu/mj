import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuleConfig, validateRuleConfig, getDefaultRuleConfigPath } from '../../src/config/rule-config.js';

describe('RuleConfig - Loading and Validation', () => {
  it('should load default rule config successfully', () => {
    const configPath = getDefaultRuleConfigPath();
    const config = loadRuleConfig(configPath);

    assert.equal(config.variant, 'riichi-4p');
    assert.equal(config.multipleRon.mode, 'allow_up_to_3');
    assert.equal(config.multipleRon.atamahane, false);
    assert.equal(config.scoring.kiriageMangan, true);
    assert.equal(config.scoring.kazoeYakuman, 'yakuman');
    assert.equal(config.pao.enabled, true);
    assert.equal(config.nagashiMangan.enabled, true);
    assert.equal(config.nagashiMangan.treatAsWin, true);
  });

  it('should validate correct config object', () => {
    const config = {
      variant: 'riichi-4p',
      multipleRon: {
        mode: 'allow_up_to_3',
        atamahane: false,
        riichiBetDistribution: 'seat_order_nearest_to_discarder'
      },
      scoring: {
        kiriageMangan: true,
        kazoeYakuman: 'yakuman'
      },
      pao: {
        enabled: true,
        paymentStyle: 'configurable_full_or_split',
        applyTo: ['daisangen']
      },
      nagashiMangan: {
        enabled: true,
        treatAsWin: true
      }
    };

    assert.doesNotThrow(() => {
      validateRuleConfig(config);
    });
  });

  it('should reject invalid variant', () => {
    const config = {
      variant: 'invalid-variant',
      multipleRon: {
        mode: 'allow_up_to_3',
        atamahane: false,
        riichiBetDistribution: 'seat_order_nearest_to_discarder'
      },
      scoring: {
        kiriageMangan: true,
        kazoeYakuman: 'yakuman'
      },
      pao: {
        enabled: true,
        paymentStyle: 'full',
        applyTo: []
      },
      nagashiMangan: {
        enabled: true,
        treatAsWin: true
      }
    };

    assert.throws(() => {
      validateRuleConfig(config);
    });
  });

  it('should reject invalid multipleRon mode', () => {
    const config = {
      variant: 'riichi-4p',
      multipleRon: {
        mode: 'invalid_mode',
        atamahane: false,
        riichiBetDistribution: 'seat_order_nearest_to_discarder'
      },
      scoring: {
        kiriageMangan: true,
        kazoeYakuman: 'yakuman'
      },
      pao: {
        enabled: true,
        paymentStyle: 'full',
        applyTo: []
      },
      nagashiMangan: {
        enabled: true,
        treatAsWin: true
      }
    };

    assert.throws(() => {
      validateRuleConfig(config);
    });
  });

  it('should reject invalid kazoeYakuman mode', () => {
    const config = {
      variant: 'riichi-4p',
      multipleRon: {
        mode: 'allow_up_to_3',
        atamahane: false,
        riichiBetDistribution: 'seat_order_nearest_to_discarder'
      },
      scoring: {
        kiriageMangan: true,
        kazoeYakuman: 'invalid'
      },
      pao: {
        enabled: true,
        paymentStyle: 'full',
        applyTo: []
      },
      nagashiMangan: {
        enabled: true,
        treatAsWin: true
      }
    };

    assert.throws(() => {
      validateRuleConfig(config);
    });
  });

  it('should reject missing required fields', () => {
    const config = {
      variant: 'riichi-4p',
      multipleRon: {
        mode: 'allow_up_to_3',
        atamahane: false,
        riichiBetDistribution: 'seat_order_nearest_to_discarder'
      },
      scoring: {
        kiriageMangan: true,
        kazoeYakuman: 'yakuman'
      },
      pao: {
        enabled: true,
        paymentStyle: 'full',
        applyTo: []
      }
      // Missing nagashiMangan
    };

    assert.throws(() => {
      validateRuleConfig(config);
    });
  });

  it('should validate pao yakuman types', () => {
    const config = {
      variant: 'riichi-4p',
      multipleRon: {
        mode: 'allow_up_to_3',
        atamahane: false,
        riichiBetDistribution: 'seat_order_nearest_to_discarder'
      },
      scoring: {
        kiriageMangan: true,
        kazoeYakuman: 'yakuman'
      },
      pao: {
        enabled: true,
        paymentStyle: 'full',
        applyTo: ['daisangen', 'daisuushi', 'tsuuiisou_optional', 'suukantsu_optional']
      },
      nagashiMangan: {
        enabled: true,
        treatAsWin: true
      }
    };

    assert.doesNotThrow(() => {
      validateRuleConfig(config);
    });
  });

  it('should reject invalid pao yakuman type', () => {
    const config = {
      variant: 'riichi-4p',
      multipleRon: {
        mode: 'allow_up_to_3',
        atamahane: false,
        riichiBetDistribution: 'seat_order_nearest_to_discarder'
      },
      scoring: {
        kiriageMangan: true,
        kazoeYakuman: 'yakuman'
      },
      pao: {
        enabled: true,
        paymentStyle: 'full',
        applyTo: ['invalid_yakuman']
      },
      nagashiMangan: {
        enabled: true,
        treatAsWin: true
      }
    };

    assert.throws(() => {
      validateRuleConfig(config);
    });
  });

  it('should handle all riichi bet distribution modes', () => {
    const modes = [
      'seat_order_nearest_to_discarder',
      'split_equally',
      'to_next_dealer'
    ];

    modes.forEach(mode => {
      const config = {
        variant: 'riichi-4p',
        multipleRon: {
          mode: 'allow_up_to_3',
          atamahane: false,
          riichiBetDistribution: mode
        },
        scoring: {
          kiriageMangan: true,
          kazoeYakuman: 'yakuman'
        },
        pao: {
          enabled: true,
          paymentStyle: 'full',
          applyTo: []
        },
        nagashiMangan: {
          enabled: true,
          treatAsWin: true
        }
      };

      assert.doesNotThrow(() => {
        validateRuleConfig(config);
      }, `Should accept riichiBetDistribution mode: ${mode}`);
    });
  });
});
