'use strict';

const { getStoreForEvent } = require('./lib/blobStore.js');
const { corsHeaders, jsonResponse } = require('./lib/http.js');
const { getSiteUrl, appEntryUrl } = require('./lib/siteConfig.js');
const { verifyEmailToken } = require('./lib/emailVerify.js');

exports.handler = async (event) => {
  const cors = corsHeaders(event, 'GET, OPTIONS');
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, cors, { error: 'method_not_allowed' });
  }

  const params = event.queryStringParameters || {};
  const token = String(params.token || '').trim();
  if (!token) {
    return jsonResponse(400, cors, { error: 'invalid_or_expired_token' });
  }

  const store = getStoreForEvent(event);
  const result = await verifyEmailToken(store, token);
  if (!result.ok) {
    return jsonResponse(400, cors, { error: result.error || 'invalid_or_expired_token' });
  }

  const redirect = `${appEntryUrl()}?emailVerified=1`;
  return {
    statusCode: 302,
    headers: {
      ...cors,
      Location: redirect,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
};
