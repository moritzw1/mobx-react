export function isStateless(component) {
    // `function() {}` has prototype, but `() => {}` doesn't
    // `() => {}` via Babel has prototype too.
    return !(component.prototype && component.prototype.render)
}

let symbolId = 0
function createSymbol(name) {
    if (typeof Symbol === "function") {
        return Symbol(name)
    }
    const symbol = `__$mobx-react ${name} (${symbolId})`
    symbolId++
    return symbol
}

const createdSymbols = {}
export function newSymbol(name) {
    if (!createdSymbols[name]) {
        createdSymbols[name] = createSymbol(name)
    }
    return createdSymbols[name]
}

export function shallowEqual(objA, objB) {
    //From: https://github.com/facebook/fbjs/blob/c69904a511b900266935168223063dd8772dfc40/packages/fbjs/src/core/shallowEqual.js
    if (is(objA, objB)) return true
    if (typeof objA !== "object" || objA === null || typeof objB !== "object" || objB === null) {
        return false
    }
    const keysA = Object.keys(objA)
    const keysB = Object.keys(objB)
    if (keysA.length !== keysB.length) return false
    for (let i = 0; i < keysA.length; i++) {
        if (!hasOwnProperty.call(objB, keysA[i]) || !is(objA[keysA[i]], objB[keysA[i]])) {
            return false
        }
    }
    return true
}

function is(x, y) {
    // From: https://github.com/facebook/fbjs/blob/c69904a511b900266935168223063dd8772dfc40/packages/fbjs/src/core/shallowEqual.js
    if (x === y) {
        return x !== 0 || 1 / x === 1 / y
    } else {
        return x !== x && y !== y
    }
}

// based on https://github.com/mridgway/hoist-non-react-statics/blob/master/src/index.js
const hoistBlackList = {
    $$typeof: 1,
    render: 1,
    compare: 1,
    type: 1,
    childContextTypes: 1,
    contextType: 1,
    contextTypes: 1,
    defaultProps: 1,
    getDefaultProps: 1,
    getDerivedStateFromError: 1,
    getDerivedStateFromProps: 1,
    mixins: 1,
    propTypes: 1
}

export function copyStaticProperties(base, target) {
    const protoProps = Object.getOwnPropertyNames(Object.getPrototypeOf(base))
    Object.getOwnPropertyNames(base).forEach(key => {
        if (!hoistBlackList[key] && !protoProps.includes(key)) {
            Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(base, key))
        }
    })
}

/**
 * Helper to set `prop` to `this` as non-enumerable (hidden prop)
 * @param target
 * @param prop
 * @param value
 */
export function setHiddenProp(target, prop, value) {
    if (!Object.hasOwnProperty.call(target, prop)) {
        Object.defineProperty(target, prop, {
            enumerable: false,
            configurable: true,
            writable: true,
            value
        })
    } else {
        target[prop] = value
    }
}

/**
 * Utilities for patching componentWillUnmount, to make sure @disposeOnUnmount works correctly icm with user defined hooks
 * and the handler provided by mobx-react
 */
const mobxMixins = newSymbol("patchMixins")
const mobxPatchedDefinition = newSymbol("patchedDefinition")

function getMixins(target, methodName) {
    const mixins = (target[mobxMixins] = target[mobxMixins] || {})
    const methodMixins = (mixins[methodName] = mixins[methodName] || {})
    methodMixins.locks = methodMixins.locks || 0
    methodMixins.methods = methodMixins.methods || []
    return methodMixins
}

function wrapper(realMethod, mixins, ...args) {
    // locks are used to ensure that mixins are invoked only once per invocation, even on recursive calls
    mixins.locks++

    try {
        let retVal
        if (realMethod !== undefined && realMethod !== null) {
            retVal = realMethod.apply(this, args)
        }

        return retVal
    } finally {
        mixins.locks--
        if (mixins.locks === 0) {
            mixins.methods.forEach(mx => {
                mx.apply(this, args)
            })
        }
    }
}

function wrapFunction(realMethod, mixins) {
    const fn = function(...args) {
        wrapper.call(this, realMethod, mixins, ...args)
    }
    return fn
}

export function patch(target, methodName, mixinMethod) {
    const mixins = getMixins(target, methodName)

    if (mixins.methods.indexOf(mixinMethod) < 0) {
        mixins.methods.push(mixinMethod)
    }

    const oldDefinition = Object.getOwnPropertyDescriptor(target, methodName)
    if (oldDefinition && oldDefinition[mobxPatchedDefinition]) {
        // already patched definition, do not repatch
        return
    }

    const originalMethod = target[methodName]
    const newDefinition = createDefinition(
        target,
        methodName,
        oldDefinition ? oldDefinition.enumerable : undefined,
        mixins,
        originalMethod
    )

    Object.defineProperty(target, methodName, newDefinition)
}

function createDefinition(target, methodName, enumerable, mixins, originalMethod) {
    let wrappedFunc = wrapFunction(originalMethod, mixins)

    return {
        [mobxPatchedDefinition]: true,
        get: function() {
            return wrappedFunc
        },
        set: function(value) {
            if (this === target) {
                wrappedFunc = wrapFunction(value, mixins)
            } else {
                // when it is an instance of the prototype/a child prototype patch that particular case again separately
                // since we need to store separate values depending on wether it is the actual instance, the prototype, etc
                // e.g. the method for super might not be the same as the method for the prototype which might be not the same
                // as the method for the instance
                const newDefinition = createDefinition(this, methodName, enumerable, mixins, value)
                Object.defineProperty(this, methodName, newDefinition)
            }
        },
        configurable: true,
        enumerable: enumerable
    }
}
