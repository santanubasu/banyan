require("node-polyfill");

var log = require("loglevel");
var _ = require("underscore");
var $ = require("jquery");
var q = require("q");
var Observe = require("observe-js");
var Queue = require("./queue.js");
var shared = require("./shared.js");
var config = require("./config.js");
var traverse = require("traverse");
var ObjectPath = require("object-path");
var extend = require("node.extend");

var Store = Object.extend({
    initialize:function(options) {
        this.graph = {};
        return this;
    },
    upgradePatch:function(patch, options) {
        var thiz = this;
        traverse(patch).forEach(function() {
            if (this.notRoot&&shared.Entity.isEntity(this.node)) {
                var guid = shared.Entity.getGuid(this.node);
                var trackedEntity = thiz.graph[guid];
                if (!trackedEntity) {
                    trackedEntity = this.node;
                    thiz.graph[guid] = trackedEntity;
                }
                this.update(trackedEntity, true);
            }
        })
    },
    discardObservations:function(root, options) {
        traverse(root).forEach(function(value) {
            if (this.key==="_observer") {
                value.discardChanges();
            }
        })
    },
    closeObservers:function(root, options) {
        traverse(root).forEach(function(value) {
            if (this.key==="_observer") {
                value.close();
            }
        })
    },
    put:function(patch, options) {
        var thiz = this;
        var guid = shared.Entity.getGuid(patch);
        if (!guid) {
            throw "Cannot put patch in store because a guid could not be determined.";
        }

        this.upgradePatch(patch);
        var entity = this.graph[guid];

        if (!entity) {
            entity = shared.Entity.getProxy(patch);
            var resource = shared.Resource.forEntity(entity);
            if (resource) {
                extend(true, entity, resource.entityTemplate);
            }
            shared.Entity.applyPatch(entity, patch);
            this.track(entity);
        }
        else if (shared.Entity.isVersionPatch(patch)) {
            shared.Entity.applyPatch(entity, patch);
        }
        else {
            var versionCheck = shared.Entity.checkVersion(entity, patch);

            if (versionCheck===shared.Entity.VERSION_AHEAD) {
                this.closeObservers(entity);
                shared.Entity.strip(entity);
                var resource = shared.Resource.forEntity(entity);
                if (resource) {
                    extend(true, entity, resource.entityTemplate);
                }
            }

            shared.Entity.applyPatch(entity, patch);

            if (versionCheck===shared.Entity.VERSION_AHEAD) {
                this.buildObservers(entity, "");
            }
        }

        this.discardObservations(entity);
        Platform.performMicrotaskCheckpoint();
        return q(entity);
    },
    get:function(fetch, options) {
        var guid = shared.Resource.buildGuid(fetch[config.syntax.idKey], fetch[config.syntax.metaKey]._r);
        if (guid in this.graph) {
            return this.graph[guid]
        }
        else {
            return undefined;
        }
    },
    buildObservers:function(entity, path, options) {
        var target = shared.Entity.getValueAtPath(entity, path);
        if (_.isArray(target)) {
            var metadata = shared.Entity.getOrCreateValueAtPath(target, config.syntax.metaKey, {});
            metadata._observer = this.buildArrayObserver(entity, path);
            target.forEach(function(element, index) {
                this.buildObservers(entity, extendedPath+"["+index+"]");
            }.bind(this))
        }
        else if (_.isObject(target)) {
            if (shared.Entity.isEntity(target)&&target!==entity) {
                return;
            }
            var metadata = shared.Entity.getOrCreateValueAtPath(target, config.syntax.metaKey, {});
            metadata._observer = this.buildObjectObserver(entity, path);
            for (var key in target) {
                if (key===config.syntax.idKey||key===config.syntax.metaKey) {
                    continue;
                }
                var extendedPath = shared.Path.joinPath(path, key);
                this.buildObservers(entity, extendedPath);
            }
        }
    },
    buildObjectObserver:function(entity, path, options) {
        var object = shared.Entity.getValueAtPath(entity, path);
        var observer = new Observe.ObjectObserver(object);
        var resource = shared.Resource.forEntity(entity);
        observer.open(function(added, removed, changed, getOldValue) {
            var patch = {};
            var valid = true;
            var add = function(value, key) {
                var extendedPath = shared.Path.joinPath(path, key);
                var validation = resource.validate(extendedPath, value, shared.Entity.getMetaData(entity, extendedPath));
                if (validation.state===shared.Resource.validationStates.valid) {
                    if (shared.Entity.isEntity(value)) {
                        patch[extendedPath] = shared.Entity.getProxy(value);
                    }
                    else {
                        patch[extendedPath] = value;
                        this.buildObservers(entity, extendedPath);
                    }
                }
                else {
                    valid = false;
                }
                ObjectPath.set(entity, shared.Path.joinPath(shared.Path.buildMetadataPath(extendedPath), config.syntax.validationPath), validation);
            }.bind(this);
            var change = function(value, key) {
                var extendedPath = shared.Path.joinPath(path, key);
                var oldValue = getOldValue(key);
                this.closeObservers(oldValue);
                var validation = resource.validate(extendedPath, value, shared.Entity.getMetaData(entity, extendedPath));
                if (validation.state===shared.Resource.validationStates.valid) {
                    if (shared.Entity.isEntity(value)) {
                        patch[extendedPath] = shared.Entity.getProxy(value);
                    }
                    else {
                        patch[extendedPath] = value;
                        this.buildObservers(entity, extendedPath);
                    }
                }
                else {
                    valid = false;
                }
                ObjectPath.set(entity, shared.Path.joinPath(shared.Path.buildMetadataPath(extendedPath), config.syntax.validationPath), validation);
            }.bind(this);
            var remove = function(value, key) {
                var extendedPath = shared.Path.joinPath(path, key);
                var validation = resource.validate(extendedPath, undefined, shared.Entity.getMetaData(entity, extendedPath));
                if (validation.state===shared.Resource.validationStates.valid) {
                    var oldValue = getOldValue(key);
                    this.closeObservers(oldValue);
                    patch[extendedPath] = config.syntax.deletionToken;
                }
                else {
                    valid = false;
                }
                ObjectPath.set(entity, shared.Path.joinPath(shared.Path.buildMetadataPath(extendedPath), config.syntax.validationPath), validation);
            }.bind(this);

            _.each(added, add);
            _.each(changed, change);
            _.each(removed, remove);

            if (valid) {
                patch[config.syntax.idKey] = entity[config.syntax.idKey];
                patch[config.syntax.versionKey] = entity[config.syntax.versionKey];
                patch[config.syntax.metaKey] = _.pick(entity[config.syntax.metaKey], "_r");
                patch[config.syntax.metaKey]._op = shared.Resource.patch;
                dispatcher.queueOutbound(patch);
            }
        }.bind(this));
        return observer;
    },
    buildArrayObserver:function(entity, path, options) {
        var array = shared.Entity.getValueAtPath(entity, path);
        var observer = new Observe.ArrayObserver(array);
        observer.open(function(splices) {
            var patch = {};
            patch[path] = splices.map(function(splice) {
                var index = splice.index;
                var removed = splice.removed;
                var added = array.slice(index, index+splice.addedCount);
                removed.forEach(function(element) {
                    if (shared.Entity.isEntity(element)) {
                    }
                    else {
                        this.closeObservers(element);
                    }
                }.bind(this))
                return [
                    index,
                    removed.length,
                    added.map(function(element, offset) {
                        if (shared.Entity.isEntity(element)) {
                            return shared.Entity.getProxy(element);
                        }
                        else {
                            this.buildObservers(entity, path+"["+(index+offset)+"]");
                            return element;
                        }
                    }.bind(this))
                ]
            }.bind(this))
            patch[config.syntax.idKey] = entity[config.syntax.idKey];
            patch[config.syntax.versionKey] = entity[config.syntax.versionKey];
            patch[config.syntax.metaKey] = _.pick(entity[config.syntax.metaKey], "_r");
            patch[config.syntax.metaKey]._op = shared.Resource.patch;
            dispatcher.queueOutbound(patch);
        }.bind(this));
        return observer;
    },
    track:function(entity, options) {
        if (!shared.Entity.isEntity(entity)) {
            throw "Cannot track non-entity objects.";
        }
        var guid = shared.Entity.getGuid(entity);
        if (guid in this.graph) {
            if (this.graph[guid]===entity) {
                log.info("Entity with GUID "+guid+" is already being tracked.");
            }
            else {
                var message = "Cannot track entity with GUID "+guid+" because it is already being tracked and is not referentially equal to the entity already in the store.";
                log.error(message)
                throw {
                    message:message,
                    guid:guid
                };
            }
        }
        this.graph[guid] = entity;
        this.buildObservers(entity, "");
    },
    untrack:function(entity, options) {
        if (!shared.Entity.isEntity(entity)) {
            throw "Cannot untrack non-entity objects.";
        }
        var guid = shared.Entity.getGuid(entity);
        if (guid in this.graph) {
            log.warn("Attempted to untrack an entity with GUID "+guid+" that is not being tracked.");
            return;
        }
        this.closeObservers(entity);
        delete this.graph[guid];
    }
})
var store = module.exports.store = Store.new();

var Dispatcher = Object.extend({
    initialize:function(options) {
        this.inQueue = Queue.new();
        this.outQueue = Queue.new();
        return this;
    },
    setEndpoint:function(endpoint) {
        this.endpoint = endpoint;
    },
    queueOutbound:function(operation, options) {
        var deferred = q.defer();
        this.outQueue.enqueue({
            operation:operation,
            deferred:deferred
        });
        // TODO add more configurability here so all changes are not immediately flushed
        this.flushOutbound();
        return deferred.promise;
    },
    queueInbound:function(operation, options) {
        var deferred = q.defer();
        this.inQueue.enqueue({
            operation:operation,
            deferred:deferred
        });
        return deferred.promise;
    },
    flushOutbound:function(options) {
        var items = this.outQueue.dequeueAll();
        if (items.length>0) {
            var operations = items.map(function(item) {
                return item.operation;
            });
            return q($
                .ajax({
                    url:this.endpoint,
                    type:"POST",
                    data:JSON.stringify(operations, function(key, value) {
                        if (key===config.syntax.metaKey) {
                            return _.pick(value, "_r", "_op");
                        }
                        else {
                            return value;
                        }
                    }),
                    dataType:"json",
                    contentType:"application/json"
                }))
                .then(function(data) {
                    data.forEach(function(result, index) {
                        if (_.isArray(result)) {
                            items[index].deferred.resolve(q.all(result.map(function(operation) {
                                return this.queueInbound(operation);
                            }.bind(this))));
                        }
                        else {
                            items[index].deferred.resolve(this.queueInbound(result));
                        }
                    }.bind(this))
                    return this.flushInbound();
                }.bind(this))
                .fail(function(e) {
                    var message = "Operation set failed round trip to server."
                    log.error(message);
                    throw {
                        message:message,
                        operations:operations
                    }
                });
        }
        else {
            return q();
        }
    },
    flushInbound:function(options) {
        var items = this.inQueue.dequeueAll();
        return q.all(items.map(function(item) {
            return store
                .put(item.operation)
                .then(function(entity) {
                    item.deferred.resolve(entity);
                });
        }.bind(this)))
    }
});

var dispatcher = module.exports.dispatcher = Dispatcher.new();

var ResourceMixin = module.exports.ResourceMixin = Object.extend({
    fetchLocal:function(fetch, options) {
        var overlay = {}
        overlay[config.syntax.metaKey] = {};
        overlay[config.syntax.metaKey]._r = this.resourceName;
        return store.get(extend(true, {}, fetch, overlay), options)
    },
    fetchRemote:function(operation, fetch, options) {
        var overlay = {}
        overlay[config.syntax.metaKey] = {};
        overlay[config.syntax.metaKey]._r = this.resourceName;
        overlay[config.syntax.metaKey]._op = operation;
        return dispatcher.queueOutbound(extend(true, {}, fetch, overlay));
    },
    patchNew:function(patch, options) {
        var overlay = {}
        overlay[config.syntax.metaKey] = {};
        overlay[config.syntax.metaKey]._r = this.resourceName;
        return dispatcher.queueOutbound(extend(true, {}, patch, overlay));
    }
})


