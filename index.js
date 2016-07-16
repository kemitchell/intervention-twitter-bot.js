#!/usr/bin/env node
var Intervention = require('intervention')
var Twit = require('twit')
var https = require('https')
var level = require('level')
var parseJSON = require('json-parse-errback')
var pino = require('pino')

var log = pino()

var env = process.env
var requiredEnvVars = [
  'TWITTER_CONSUMER_KEY',
  'TWITTER_CONSUMER_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'TWITTER_HANDLE'
]

requiredEnvVars.forEach(function (required) {
  if (!env.hasOwnProperty(required) || env[required].length === 0) {
    log.error({event: 'missing env var', var: required})
    process.exit(1)
  }
})

var levelup = level('intervention-twitter-bot.leveldb')
levelup.get('sequence', function (error, from) {
  if (error) {
    if (error.notFound) from = undefined
    else die(error)
  }

  log.info({event: 'following', from: from})
  var intervention = new Intervention(levelup, from)
  .on('dependency', function (user, depending, dependency) {
    log.info({
      event: 'dependency',
      user: user,
      depending: depending,
      dependency: dependency
    })
  })
  .on('devDependency', function (user, depending, dependency) {
    log.info({
      event: 'devDependency',
      user: user,
      depending: depending,
      dependency: dependency
    })
  })

  log.info({event: 'requesting update_seq'})
  https.get('https://replicate.npmjs.com', function (response) {
    var buffer = []
    response
    .on('data', function (chunk) { buffer.push(chunk) })
    .once('error', die)
    .once('end', function () {
      var body = Buffer.concat(buffer)
      parseJSON(body, function (error, data) {
        if (error) die(error)
        log.info({event: 'update_seq', value: data.update_seq})
        startBotWhenCaughtUp(data.update_seq)
      })
    })
  })

  function startBotWhenCaughtUp (target) {
    var interval = setInterval(
      function checkIfCaughtUp () {
        var current = intervention.sequence()
        log.info({event: 'progress', current: current, target: target})
        if (current >= target) {
          log.info({event: 'caught up', current: current, target: target})
          clearInterval(interval)
          startBot()
          emitEventsForSaved()
        }
      }
    )
  }

  function startBot () {
    var twitter = new Twit({
      consumer_key: env.TWITTER_CONSUMER_KEY,
      consumer_secret: env.TWITTER_CONSUMER_SECRET,
      access_token: env.TWITTER_ACCESS_TOKEN,
      access_token_secret: env.TWITTER_ACCESS_TOKEN_SECRET
    })
    twitter.stream('statuses/filter', {track: '@' + env.TWITTER_HANDLE})
    .on('tweet', function (tweet) {
      log.info({event: 'mention', tweet: tweet})
    })
  }

  function emitEventsFor (twitterHandle, npmUserName) {
    var data = {twitterName: twitterHandle, npmName: npmUserName}
    var key = 'recipients/' + encodeURIComponent(twitterHandle)
    levelup.put(key, data, function (error) {
      if (error) die(error)
      intervention.emitEventsFor(npmUserName)
    })
  }

  function emitEventsForSaved () {
    levelup.createReadStream({
      gte: 'recipients/',
      lte: 'recipients/~',
      keys: false,
      values: true
    })
    .on('error', die)
    .on('data', function (data) {
      var parsed = JSON.parse(data)
      intervention.emitEventsFor(parsed.npmName)
    })
  }
})

function die (error) {
  log.error(error)
  process.exit(1)
}
