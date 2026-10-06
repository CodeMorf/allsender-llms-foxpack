import test from 'node:test';
import assert from 'node:assert/strict';
import { zernioIdentity, zernioCommentIds, zernioPostAccounts } from '../services/zernio/zernio-payload.js';
import { verifiedConnectionCount } from '../services/zernio/zernio-health.js';
import { safeAiError } from '../utils/ai-error-details.js';
import amazon from '../services/amazon-deals-live.service.js';
import { correctFoxpackRates } from '../services/branch-router.service.js';
import tracking from '../services/foxpack-tracking.service.js';
import omnicall from '../services/omnicall.service.js';

test('the event UUID never becomes a tenant account identifier', () => {
  assert.equal(zernioIdentity({id:'event-only'}).accountId,null);
  assert.equal(zernioIdentity({id:'event-only',account:{accountId:'account',profileId:'profile'}}).accountId,'account');
  assert.deepEqual(zernioPostAccounts({post:{platforms:[{accountId:'a'},{accountId:'a'},{accountId:'b'}]}}),['a','b']);
});

test('external Facebook and Instagram comments use their platform-native post id', () => {
  assert.deepEqual(zernioCommentIds({comment:{id:'18116801432283179',platformPostId:'18085512575320252'},post:{platformPostId:'18085512575320252'}}),{commentId:'18116801432283179',postId:'18085512575320252'});
  assert.equal(zernioCommentIds({comment:{id:'c',postId:'',platformPostId:'native'},post:{id:''}}).postId,'native');
  assert.equal(zernioCommentIds({comment:{id:'c',postId:'internal',platformPostId:'native'}}).postId,'internal');
});

test('provider health counts only active accounts matching local profile ownership', () => {
  const local=[{zernio_account_id:'fox-ig',zernio_profile_id:'fox'},{zernio_account_id:'all-fb',zernio_profile_id:'all'}];
  const remote=[{id:'fox-ig',profileId:'fox',isActive:true},{id:'all-fb',profileId:'other',isActive:true},{id:'foreign',profileId:'foreign',isActive:true}];
  assert.equal(verifiedConnectionCount(local,remote),1);
  assert.equal(verifiedConnectionCount(local,[{id:'fox-ig',profileId:{_id:'fox'},isActive:false}]),0);
});

test('AI error details classify outages without disclosing tenant credentials', () => {
  const secret='tenant-secret-value';
  const details=safeAiError({message:`Insufficient Balance for ${secret} Bearer abc sk-private-value`,statusCode:402},[secret]);
  assert.equal(details.code,'AI_BALANCE_UNAVAILABLE');
  assert.equal(details.retryable,false);
  assert.ok(!details.error.includes(secret));
  assert.ok(!details.error.includes('sk-private'));
  assert.equal(safeAiError({message:'timed out'}).code,'AI_TIMEOUT');
  assert.equal(safeAiError({message:'Unsupported model version v1'}).code,'AI_SDK_INCOMPATIBLE');
});

test('the exact FoxPack workspace alone receives the FoxPack tariff guard and tracking', async () => {
  const text='China cuesta RD$245 por libra';
  assert.equal(correctFoxpackRates(text,'6ab82a6847ab241dfafe4bc0'),'China cuesta RD$780 por libra');
  for(const workspace of ['6ab82a6847ab241dfafe4bc1','6aa863ad921399335654423f',null]) {
    assert.equal(correctFoxpackRates(text,workspace),text);
    assert.equal(await tracking.handleTrackingQuestion({workspaceId:workspace,trackingCode:'unused'}),null);
  }
});

test('an offer-followup phrase cannot become a new Amazon product search', () => {
  assert.equal(amazon.extraerConsulta('enviame link primera'),'');
  assert.equal(amazon.extraerConsulta('quiero un fire tv'),'fire tv');
  assert.equal(amazon.extraerConsulta('busco una memoria usb'),'memoria usb');
});

test('missing tenant credentials fail closed without any platform fallback', async () => {
  const result=await omnicall.chatCompletion({messages:[{role:'user',content:'health'}],customApiKey:null});
  assert.equal(result.success,false);
  assert.equal(result.errors[0].code,'AI_KEY_MISSING');
});

test('all installed provider adapters support the SDK v2 model contract', () => {
  for(const [provider,model] of [['deepseek','deepseek-chat'],['openai','gpt-4o-mini'],['anthropic','claude-sonnet-4-20250514'],['google','gemini-2.0-flash'],['xai','grok-3'],['cohere','command-r'],['mistral','mistral-small-latest'],['groq','llama-3.3-70b-versatile'],['together','meta-llama/Llama-3.3-70B-Instruct-Turbo'],['fireworks','accounts/fireworks/models/llama-v3p3-70b-instruct'],['custom','model']]) {
    const instance=omnicall.createModel({provider,model,apiKey:'not-used',baseUrl:'https://example.com/v1'});
    assert.equal(instance.specificationVersion,'v2',provider);
  }
});
