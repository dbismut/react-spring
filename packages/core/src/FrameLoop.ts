import * as G from 'shared/globals'
import { Animated } from '@react-spring/animated'
import { FrameRequestCallback } from 'shared/types'
import { Controller, FrameUpdate } from './Controller'
import { ActiveAnimation } from './types/spring'
import { Spring } from './legacy'

type FrameUpdater = (this: FrameLoop) => boolean
type FrameListener = (this: FrameLoop, updates: FrameUpdate[]) => void
type RequestFrameFn = (cb: FrameRequestCallback) => number | void

export class FrameLoop {
  /**
   * On each frame, these controllers are searched for values to animate.
   */
  controllers = new Map<number, Controller>()
  /**
   * True when no controllers are animating.
   */
  idle = true
  /**
   * Process the next animation frame.
   *
   * Can be passed to `requestAnimationFrame` quite nicely.
   *
   * This advances any `Controller` instances added to it with the `start` function.
   */
  update: FrameUpdater
  /**
   * This is called at the end of every frame.
   *
   * The listener is passed an array of key-value pairs for each controller that
   * was updated in the most recent frame. The indices are directly mapped to
   * the `controllers` array, so empty arrays may exist.
   */
  onFrame: FrameListener
  /**
   * The `requestAnimationFrame` function or a custom scheduler.
   */
  requestFrame: RequestFrameFn

  constructor({
    update,
    onFrame,
    requestFrame,
  }: {
    update?: FrameUpdater
    onFrame?: FrameListener
    requestFrame?: RequestFrameFn
  } = {}) {
    this.requestFrame =
      // The global `requestAnimationFrame` must be dereferenced to avoid "Illegal invocation" errors
      requestFrame || (fn => (void 0, G.requestAnimationFrame)(fn))

    this.onFrame =
      (onFrame && onFrame.bind(this)) ||
      (updates => {
        updates.forEach(update => {
          const ctrl = this.controllers.get(update[0])
          if (ctrl) ctrl.onFrame(update)
        })
      })

    this.update =
      (update && update.bind(this)) ||
      (() => {
        if (this.idle) {
          return false
        }

        // Update the animations.
        const updates: FrameUpdate[] = []
        for (const id of Array.from(this.controllers.keys())) {
          let idle = true
          const ctrl = this.controllers.get(id)!
          const changes: FrameUpdate[2] = ctrl.props.onFrame ? [] : null
          for (const config of ctrl.configs) {
            if (config.idle) continue
            if (this.advance(config, changes)) {
              idle = false
            }
          }
          if (idle || changes) {
            updates.push([id, idle, changes])
          }
        }

        // Notify the controllers!
        this.onFrame(updates)

        // Are we done yet?
        if (!this.controllers.size) {
          return !(this.idle = true)
        }

        // Keep going.
        this.requestFrame(this.update)
        return true
      })
  }

  start(ctrl: Controller) {
    this.controllers.set(ctrl.id, ctrl)
    if (this.idle) {
      this.idle = false
      this.requestFrame(this.update)
    }
  }

  stop(ctrl: Controller) {
    this.controllers.delete(ctrl.id)
  }

  /** Advance an animation forward one frame. */
  advance(config: ActiveAnimation, changes: FrameUpdate[2]): boolean {
    const time = G.now()

    let active = false
    let changed = false
    for (let i = 0; i < config.animatedValues.length; i++) {
      const animated = config.animatedValues[i]
      if (animated.done) continue
      changed = true

      let to: any = config.toValues[i]
      const target: any = to instanceof Animated ? to : null
      if (target) to = target.getValue()

      const from: any = config.fromValues[i]

      // Jump to end value for immediate animations
      if (
        config.immediate ||
        typeof from === 'string' ||
        typeof to === 'string'
      ) {
        animated.setValue(to)
        animated.done = true
        continue
      }

      const startTime = animated.startTime!
      const lastTime = animated.lastTime !== void 0 ? animated.lastTime : time

      let deltaTime = time - lastTime

      // http://gafferongames.com/game-physics/fix-your-timestep/
      if (deltaTime > 64) {
        deltaTime = 64
      }

      animated.elapsedTime! += deltaTime

      const v0 = Array.isArray(config.initialVelocity)
        ? config.initialVelocity[i]
        : config.initialVelocity

      let finished = false
      let position = animated.lastPosition

      let velocity: number

      // Duration easing
      if (config.duration !== void 0) {
        position =
          from +
          config.easing!(animated.elapsedTime! / config.duration) * (to - from)

        velocity = (position - animated.lastPosition) / deltaTime

        finished = time >= startTime + config.duration
      }
      // Decay easing
      else if (config.decay) {
        const decay = config.decay === true ? 0.998 : config.decay
        const e = Math.exp(-(1 - decay) * animated.elapsedTime!)

        position = from + (v0 / (1 - decay)) * (1 - e)
        // derivative of position
        velocity = v0 * e

        finished = Math.abs(animated.lastPosition - position) < 0.1
        if (finished) to = position
      }
      // Spring easing
      else {
        function euler() {
          velocity =
            animated.lastVelocity !== void 0 ? animated.lastVelocity : v0

          const w0 = Math.sqrt(config.tension! / config.mass!)

          const dt =
            config.config.dt > 20 ? config.config.dt / w0 : config.config.dt
          const numSteps = Math.ceil(deltaTime / dt)

          for (let n = 0; n < numSteps; ++n) {
            const springForce = (-config.tension! / 1000000) * (position - to)
            const dampingForce = (-config.friction! / 1000) * velocity
            const acceleration = (springForce + dampingForce) / config.mass!
            velocity = velocity + acceleration * dt
            position = position + velocity * dt
          }
        }
        function verlet() {
          velocity =
            animated.lastVelocity !== void 0 ? animated.lastVelocity : v0

          const w0 = Math.sqrt(config.tension! / config.mass!)

          const dt =
            config.config.dt > 20 ? config.config.dt / w0 : config.config.dt
          const numSteps = Math.ceil(deltaTime / dt)

          for (let n = 0; n < numSteps; ++n) {
            let prevPos = position
            let springForce = (-config.tension! / 1000000) * (position - to)
            let dampingForce = (-config.friction! / 1000) * velocity
            let acceleration = (springForce + dampingForce) / config.mass!
            position =
              position + velocity * dt + (1 - ((dt * dt) / 2) * acceleration)
            springForce = (-config.tension! / 1000000) * (position - to)
            let acceleration1 = (springForce + dampingForce) / config.mass!
            velocity = velocity + ((acceleration + acceleration1) * dt) / 2
          }
        }
        function analytical() {
          const c = config.friction!
          const m = config.mass!
          const k = config.tension!
          const x0 = to - from

          const zeta = c / (2 * Math.sqrt(k * m)) // damping ratio (dimensionless)
          const w0 = Math.sqrt(k / m) / 1000 // undamped angular frequency of the oscillator (rad/ms)
          const w1 = w0 * Math.sqrt(1.0 - zeta * zeta) // exponential decay
          const w2 = w0 * Math.sqrt(zeta * zeta - 1.0) // frequency of damped oscillation

          const t = animated.elapsedTime!
          if (zeta < 1) {
            // Under damped
            const envelope = Math.exp(-zeta * w0 * t)
            position =
              to -
              envelope *
                (((v0 + zeta * w0 * x0) / w1) * Math.sin(w1 * t) +
                  x0 * Math.cos(w1 * t))
            // This looks crazy -- it's actually just the derivative of the
            // position function
            velocity =
              zeta *
                w0 *
                envelope *
                ((Math.sin(w1 * t) * (-v0 + zeta * w0 * x0)) / w1 +
                  x0 * Math.cos(w1 * t)) -
              envelope *
                (Math.cos(w1 * t) * (-v0 + zeta * w0 * x0) -
                  w1 * x0 * Math.sin(w1 * t))
          } else if (zeta === 1) {
            // Critically damped
            const envelope = Math.exp(-w0 * t)
            position = to - envelope * (x0 + (-v0 + w0 * x0) * t)
            velocity = envelope * (-v0 * (t * w0 - 1) + t * x0 * (w0 * w0))
          } else {
            // Overdamped
            const envelope = Math.exp(-zeta * w0 * t)
            position =
              to -
              (envelope *
                ((v0 + zeta * w0 * x0) * Math.sinh(w2 * t) +
                  w2 * x0 * Math.cosh(w2 * t))) /
                w2
            velocity =
              (envelope *
                zeta *
                w0 *
                (Math.sinh(w2 * t) * (v0 + zeta * w0 * x0) +
                  x0 * w2 * Math.cosh(w2 * t))) /
                w2 -
              (envelope *
                (w2 * Math.cosh(w2 * t) * (v0 + zeta * w0 * x0) +
                  w2 * w2 * x0 * Math.sinh(w2 * t))) /
                w2
          }
        }

        const t0 = performance.now()
        switch (config.config.method) {
          case 'euler':
            euler()
            break
          case 'verlet':
            verlet()
            break
          default:
            analytical()
        }

        const t1 = performance.now()
        animated.performance = t1 - t0

        // Conditions for stopping the spring animation
        const isBouncing = config.clamp
          ? from < to
            ? position > to && velocity > 0
            : position < to && velocity < 0
          : false

        if (isBouncing) {
          velocity =
            -velocity * (typeof config.clamp! === 'number' ? config.clamp! : 0)
        }

        const isVelocity = Math.abs(velocity) <= config.precision!
        const isDisplacement =
          config.tension !== 0
            ? Math.abs(to - position) <= config.precision!
            : true

        finished =
          (isBouncing && velocity === 0) || (isVelocity && isDisplacement)
      }
      // Trails aren't done until their parents conclude
      if (finished && !(target && !target.done)) {
        // Ensure that we end up with a round value
        if (animated.value !== to) position = to
        animated.done = true
      } else {
        active = true
      }

      animated.setValue(position)
      animated.lastPosition = position
      animated.lastVelocity = velocity
      animated.lastTime = time
    }

    if (changes && changed) {
      changes.push([config.key, config.animated.getValue()])
    }

    return active
  }
}
