'use strict';
const B = require('../lib/bedrock');
const set = (v, extra) => { process.env.BEDROCK_MODEL_ID = v; delete process.env.BEDROCK_POVOLIT_PROFIL_APLIKACE; Object.assign(process.env, extra || {}); };
afterAll(() => { delete process.env.BEDROCK_MODEL_ID; delete process.env.BEDROCK_POVOLIT_PROFIL_APLIKACE; });

test('ARN globálního / US profilu v EU regionu se odmítne', () => {
    set('arn:aws:bedrock:eu-central-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6');
    expect(() => B.modelId()).toThrow(/mimo EU/);
    set('arn:aws:bedrock:eu-central-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6');
    expect(() => B.modelId()).toThrow(/mimo EU/);
});
test('ARN EU profilu a modelu v regionu projde', () => {
    set('arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-4-6');
    expect(B.modelId()).toMatch(/eu\.anthropic/);
    set('arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-sonnet-4-6');
    expect(B.modelId()).toMatch(/foundation-model/);
});
test('profil aplikace jen s výslovným povolením', () => {
    set('arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123');
    expect(() => B.modelId()).toThrow(/BEDROCK_POVOLIT_PROFIL_APLIKACE/);
    set('arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123', { BEDROCK_POVOLIT_PROFIL_APLIKACE: '1' });
    expect(B.modelId()).toMatch(/application-inference-profile/);
});
test('Fable 5 se odmítne i jako ARN', () => {
    set('arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-fable-5');
    expect(() => B.modelId()).toThrow(/ukládá/);
});
