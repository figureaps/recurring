'use strict'

const handleRecurlyError = require('./util').handleRecurlyError

const RecurlyError = require('./recurly-error')
const _ = require('lodash')
const rparser = require('./parser.js')
const debugR = require('debug')('recurring:request')
const debug = require('debug')('recurring')
const iterators = require('async-iterators')
const pkg = require('../package.json')
const querystring = require('querystring')
const log = require('./logger')

const parser = rparser.createParser()

class RecurlyData {
  constructor(options) {
    // Store a reference to the Recurring instance.
    this._recurring = options.recurring
    this.idField = options.idField
    this.enumerable = options.enumerable

    this.properties = { }
    this._resources = { }

    for (var i = 0; i < options.properties.length; i++) {
      RecurlyData.addProperty(this, options.properties[i])
    }
    this.proplist = options.properties

    this.__defineGetter__('id', function() {
      return this.properties[options.idField]
    })

    var idSetter = function() {
      var newval = arguments['0']
      this.properties[options.idField] = newval
      this.href = this.constructor.ENDPOINT + '/' + newval
    }
    this.__defineSetter__('id', idSetter)
    this.__defineSetter__(options.idField, idSetter)
  }

  static get ENDPOINT() {
    return 'https://api.recurly.com/v2/'
  }

  static addProperty(instance, propname) {
    var getterFunc = function() {
      return this.properties[propname]
    }
    var setterFunc = function() {
      var newval = arguments['0']
      this.properties[propname] = newval
    }

    instance.__defineGetter__(propname, getterFunc)
    instance.__defineSetter__(propname, setterFunc)
  }

  baseOptions() {
    return {
      headers: {
        'Accept': 'application/xml',
        'Authorization': this._recurring.AUTH_BASIC,
        'User-Agent': `${pkg.name}/${pkg.version}`,
        'X-Api-Version': '2.22'
      }
    }
  }

  go(method, uri, args, opts, callback) {
    if (typeof callback === 'undefined' && typeof opts === 'function') {
      callback = opts
      opts = { }
    }

    var options = _.merge(this.baseOptions(), opts)
    options.uri = uri

    if (method === 'GET') {
      options.qs = args
    }
    else {
      options.body = args
    }

    options.method = method

    this.execute(options, callback)
  }

  get(uri, args, opts, callback) {
    this.go('GET', uri, args, opts, callback)
  }

  put(uri, args, opts, callback) {
    this.go('PUT', uri, args, opts, callback)
  }

  post(uri, args, opts, callback) {
    this.go('POST', uri, args, opts, callback)
  }

  head(uri, args, opts, callback) {
    this.go('HEAD', uri, args, opts, callback)
  }

  all(filter, callback) {
    if (typeof callback === 'undefined' && typeof filter === 'function') {
      callback = filter
      filter = {}
    }

    filter = filter || {}

    if (!this.enumerable) {
      return callback(new Error(`${this.constructor.name} does not support .all()`))
    }

    const name = this.constructor.name
    const url = this.constructor.ENDPOINT
    const debugData = {
      name,
      url,
      filter
    }

    log.info(`[RecurlyData/all] Start`, { debugData })

    this.fetchAll(name, url, filter, (err, results) => {
      if (err) {
        log.error('[RecurlyData/all] Error', { err, debugData })
        return callback(err)
      }
      const data = { }

      _.each(results, item => {
        data[item[this.idField]] = item
      })

      log.info('[RecurlyData/all] End', { debugData })

      callback(null, data)
    })
  }

  fetchInBatches(modelName, uri, filter, callback) {
    if (typeof callback === 'undefined' && typeof filter === 'function') {
      callback = filter
      filter = {}
    }

    filter = filter || {}

    var model = this._recurring[modelName]()
    var iterator = model.iterator(filter, uri)
    iterators.forEachAsync(iterator, async function(err, item, next) {
      if (err) {
        return callback(err)
      }
      await callback(null, item)
      return next()
    }, () => log.info('[RecurlyData/fetchInBatches] End', { modelName, uri, filter }))
  }

  fetchAll(modelName, uri, filter, callback) {
    if (typeof callback === 'undefined' && typeof filter === 'function') {
      callback = filter
      filter = {}
    }

    filter = filter || {}

    var model = this._recurring[modelName]()
    var iterator = model.iterator(filter, uri)
    var result = [ ]
    iterators.forEachAsync(iterator, function(err, item, next) {
      if (err) {
        return callback(err)
      }
      result.push(item)
      return next()
    }, () => callback(null, result))
  }

  fetch(callback) {
    if (!this.href) {
      throw (new Error('cannot fetch a record without an href'))
    }

    this.get(this.href, { }, (err, response, payload) => {
      if (err) {
        return callback(err)
      }
      if (response.statusCode === 404) {
        return callback(new Error('not_found'))
      }

      this.inflate(payload)
      callback(null, this)
    })
  }

  destroy(href, callback) {
    if (typeof href === 'function') {
      callback = href
      href = this.href
    }

    const options = this.baseOptions()
    options.uri = this.href
    options.method = 'DELETE'

    const handleResponse = (err, response, payload) => {
      var error = handleRecurlyError(err, response, payload, [ 204 ])
      if (error) {
        return callback(error)
      }

      this.deleted = true
      callback(null, this.deleted)
    }

    this._recurring.request(options, function(err, response, body) {
      if (body) {
        parser.parseXML(body, function(xmlerr, result) {
          if (xmlerr) {
            return handleResponse(err, response, body)
          }
          return handleResponse(err, response, result)
        })
      }
      else {
        handleResponse(err, response)
      }
    })
  }

  inflate(json) {
    if (typeof json !== 'object') {
      // TODO throw an error
      console.error(json)
      return
    }

    var keys = Object.keys(json)
    for (var i = 0; i < keys.length; i++) {
      var prop = keys[i]
      var value = json[prop]
      if (prop === 'a') {
        // Hackery. 'a' is a list of named anchors. We treat them specially.
        this.a = { }
        var anchors = Object.keys(value)
        for (var j = 0; j < anchors.length; j++) {
          this.a[value.name] = value
        }
      }
      // if (prop === 'a') {
      //   // Hackery. 'a' is a list of named anchors. We treat them specially.
      //   this.a = { }
      //   var anchors = Object.keys(value)
      //   for (var j = 0; j < anchors.length; j++) {
      //     this.a[value[anchors[j]].name] = value[j]
      //   }
      // }
      else if (value.hasOwnProperty('href') && (Object.keys(value).length === 1)) {
        if (!this._resources) {
          this._resources = { }
        }
        this._resources[prop] = value.href

        const hrefAsArr = value.href.split('/')
        this[`recurly_${prop}_id`] = hrefAsArr[hrefAsArr.length - 1]
      }
      else {
        this[prop] = this.sanitize(value)
      }
    }
  }

  sanitize(value) {
    if (!value && value !== 0) {
      return null
    }
    else if (typeof value === 'object' && value['#'] && value.type) {
      switch (value.type) {
        case 'float':
          return parseFloat(value['#'])
        case 'integer':
          return parseInt(value['#'], 10)
        default:
          break
      }
    }
    return value
  }

  execute(options, callback) {
    debug('execute called with options: %o', options)
    this._recurring.request(options, function(err, response, body) {
      debug('execute got response with status code: %s', _.get(response, 'statusCode'))
      debugR('execute got response with body: %O', body)

      log.info('[RecurlyData/execute] Start')

      if (err) {
        console.error('recurly.' + options.method, 'error ' + JSON.stringify(err))
        log.error('[RecurlyData/execute] Error', err)
        return callback(err, response, { })
      }

      if (response.statusCode === 404) {
        return parser.parseXML(body, function(err, result) {
          if (err) {
            console.error('recurly.get', 'xml parsing error:', JSON.stringify(err), 'from body:', body)
            log.error('[RecurlyData/execute] Xml parsing error, status 404', err)
            return callback(err, response, { })
          }
          var error = new RecurlyError(result)
          callback(error, response, { })
        })
      }

      if (response.statusCode === 401) {
        log.error('[RecurlyData/execute] Error, status 401')
        return callback(new Error('Your API key is missing or invalid'), response, {})
      }

      if (options.noParse || response.statusCode === 204) {
        return callback(err, response, body)
      }

      parser.parseXML(body, function(err, result) {
        if (err) {
          console.error('recurly.get', 'xml parsing error:', JSON.stringify(err), 'from body:', body)
          log.error('[RecurlyData/execute] Xml parsing error', err)
          return callback(err, response, { })
        }

        callback(null, response, result)
      })
    })
  }

  iterator(filter, endpoint) {
    filter = filter || {}
    endpoint = endpoint || this.constructor.ENDPOINT

    let uri = filter ? `${endpoint}?${querystring.stringify(filter)}` : endpoint

    const result = [ ]
    let total = -1
    let current = 0

    return {
      next: function(cb) {
        // If we are already at the end, return nothing,
        if (total > -1 && current >= total) {
          log.info('[RecurlyData/iterator/next] At the end', { current, total })
          return cb(null)
        }

        // If this is the first hit, fetch the total count, then the first set of results.
        if (total === -1) {
          log.info('[RecurlyData/iterator/next] First hit', { total })
          return this.getTotalCount((err, res) => {
            if (err) {
              return cb(err)
            }
            total = res
            return this.getNextValue(cb)
          })
        }

        // Otherwise, just return the next result.
        log.info('[RecurlyData/iterator/next] Return next result', { total })
        return this.getNextValue(cb)
      },

      getTotalCount: done => {
        debug(`fetching result count.`)
        this.head(uri, null, { noParse: true }, (err, response, records) => {
          var error = handleRecurlyError(err, response, records, [ 200 ])
          if (error) {
            return done(error)
          }
          total = parseInt(response.headers['x-records'], 10)

          log.info('[RecurlyData/iterator/getTotalCount] Total count from headers', { total })
          debug(`result count: ${total}`)
          done(null, total)
        })
      },

      getNextValue: done => {
        // If we already have some results, return the next one.
        if (result.length) {
          current++
          done(null, result.shift())
        }

        // Otherwise fetch the next page of results if there are some.
        else {
          debug(`fetching iterator results: ${current}/${total}`)
          log.info('[RecurlyData/iterator/getNextValue] Fetching iterator results', { current, total })

          this.get(uri, { per_page: 200 }, (err, response, records) => {
            var error = handleRecurlyError(err, response, records, [ 200 ])
            if (error) {
              log.error('[RecurlyData/iterator/getNextValue] Error', error)
              return done(error)
            }

            // Ensure next attempt to fetch results pulls from next page.
            if (response.headers.link) {
              uri = response.headers.link.split('; rel="next"')[0].split(',').pop().trim().slice(1, -1)
              log.info(`[RecurlyData/iterator/getNextValue] Next uri to fetch`, { uri, link: response.headers.link })
            }

            // Process the results.
            _.each(records, record => {
              const item = this._recurring[this.constructor.name]()
              item.inflate(record)
              result.push(item)
            })

            // Grab the first item.
            var item = result.shift()
            // Increment the current counter.
            current++

            // Return it.
            done(err, item)
          })
        }
      }
    }
  }
}

module.exports = RecurlyData
