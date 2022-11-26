import pkceChallenge from 'pkce-challenge'
import { v4 as uuidv4 } from 'uuid'

import { AuthenticationError } from '@redwoodjs/graphql-server'

import { db } from 'src/lib/db'
import { logger } from 'src/lib/logger'
import { providers, types } from 'src/lib/oauth-client/providers'
import { createPlaidLink, PLAID } from 'src/lib/oAuth/providers/plaid'
import Sentry from 'src/lib/sentry'

export const oAuthUrl = async (type) => {
  try {
    if (!Object.values(types).includes(type))
      throw `OAuth Provider ${type} is not enabled.`
    if (type === PLAID) return createPlaidLink()

    const { params, urlAuthorize } = providers[type]
    const url = new URL(urlAuthorize)
    const pkce = pkceChallenge()
    url.searchParams.set('code_challenge', pkce.code_challenge) // eg. 3uWDl1fX2ioAqf38eSOFlKnxVEl_VyfaYKG2GyLndKs
    url.searchParams.set('code_challenge_method', 'S256')
    Object.keys(params).map((key) => {
      url.searchParams.set(key, params[key])
    })
    const state = uuidv4()
    // For oAuth codeGrant, we sometimes need the user id
    let userId
    if (context.currentUser?.id) userId = context.currentUser?.id

    await db.oAuth.create({
      data: {
        state,
        codeVerifier: pkce.code_verifier,
        codeChallenge: pkce.code_challenge,
        ...(userId && { member: { connect: { id: userId } } }),
      },
    })

    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    return {
      text: 'success',
      type: 'redirect',
      url: url.href,
    }
  } catch (e) {
    Sentry.captureException(e)
    throw new AuthenticationError(e)
  }
}

export const processCodeGrant = async ({ state, code, type, accountId }) => {
  try {
    logger.debug(`code grant - ${type}`)
    if (!types.includes(type)) throw `Unknown OAuth Provider - ${type}`

    let tokens
    if (type === PLAID) {
      // Skip the normal OAuth db checking
      tokens = await providers[PLAID].onSubmitCode({ code, accountId })
    } else {
      tokens = await submitCodeGrant({ state, code, type })
    }
    logger.debug({ custom: tokens }, 'onSubmitCode() response')
    return providers[type].onConnected(tokens)
  } catch (e) {
    logger.error(e)
    Sentry.captureException(e)
    throw new AuthenticationError(e)
  }
}

export const processRevoke = async (type) => {
  try {
    logger.debug(`revoke - ${type}`)
    if (!types.includes(type)) throw `Unknown OAuth Provider - ${type}`
    const { onRevoke } = providers[type]
    return onRevoke()
  } catch (e) {
    logger.error(e)
    Sentry.captureException(e)
    throw new AuthenticationError(e)
  }
}

export const submitCodeGrant = async ({ state, code, type }) => {
  if (!Object.values(types).includes(type))
    throw `OAuth Provider "${type}" is not enabled.`

  // Delete the OAuth Item
  let oAuth
  try {
    oAuth = await db.oAuth.delete({ where: { state } })
    if (!oAuth) throw 'state not valid'
  } catch (e) {
    throw 'Oauth state has expired. Please start over.'
  }

  // Check expiration
  if (new Date() - new Date(oAuth.createdAt) > 10 * 60 * 1000)
    throw 'Sorry, authentication must be completed within 10 minutes.'

  const { onSubmitCode } = providers[type]
  return onSubmitCode(code, oAuth)
}