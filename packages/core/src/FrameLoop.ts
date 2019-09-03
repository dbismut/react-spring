import * as G from 'shared/globals'
import { Animated } from '@react-spring/animated'
import { FrameRequestCallback } from 'shared/types'
import { Controller, FrameUpdate } from './Controller'
import { ActiveAnimation } from './types/spring'

type FrameUpdater = (this: FrameLoop, time?: number) => boolean
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

  lastTime?: number

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
      ((time?: number) => {
        if (this.idle) {
          return false
        }

        time = time !== void 0 ? time : performance.now()
        this.lastTime = this.lastTime !== void 0 ? this.lastTime : time
        let dt = time - this.lastTime!

        // http://gafferongames.com/game-physics/fix-your-timestep/
        if (dt > 64) dt = 64

        if (dt > 0) {
          // Update the animations.
          const updates: FrameUpdate[] = []
          for (const id of Array.from(this.controllers.keys())) {
            let idle = true
            const ctrl = this.controllers.get(id)!
            const changes: FrameUpdate[2] = ctrl.props.onFrame ? [] : null
            for (const config of ctrl.configs) {
              if (config.idle) continue
              if (this.advance(dt, config, changes)) {
                idle = false
              }
            }
            if (idle || changes) {
              updates.push([id, idle, changes])
            }
          }

          // Notify the controllers!
          this.onFrame(updates)
          this.lastTime = time

          // Are we done yet?
          if (!this.controllers.size) {
            return !(this.idle = true)
          }
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
      this.lastTime = undefined
      this.requestFrame(this.update)
    }
  }

  stop(ctrl: Controller) {
    this.controllers.delete(ctrl.id)
  }

  /** Advance an animation forward one frame. */
  advance(
    dt: number,
    config: ActiveAnimation,
    changes: FrameUpdate[2]
  ): boolean {
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

      const elapsed = (animated.elapsedTime += dt)

      const v0 = Array.isArray(config.initialVelocity)
        ? config.initialVelocity[i]
        : config.initialVelocity

      const precision =
        config.precision || Math.min(1, Math.abs(to - from) / 1000)

      let finished = false
      let position = animated.lastPosition

      let velocity: number = 0

      // Duration easing
      if (config.duration != null) {
        let p = config.progress!
        p += (1 - p) * Math.min(1, elapsed / config.duration)

        position = from + config.easing!(p) * (to - from)
        velocity = (position - animated.lastPosition) / dt

        finished = p == 1
      }
      // Decay easing
      else if (config.decay) {
        const decay = config.decay === true ? 0.998 : config.decay
        const e = Math.exp(-(1 - decay) * elapsed)

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

          //const w0 = (2 * Math.sqrt(config.tension! / config.mass!)) / 1000 // angular frequency in rad/ms

          const step =
            config.config.step > 20
              ? config.config.spep / config.w0 / 1000
              : config.config.step
          const numSteps = Math.ceil(dt / step)

          for (let n = 0; n < numSteps; ++n) {
            const springForce = (-config.tension! / 1000000) * (position - to)
            const dampingForce = (-config.friction! / 1000) * velocity
            const acceleration = (springForce + dampingForce) / config.mass!
            velocity = velocity + acceleration * step
            position = position + velocity * step
          }
        }
        // function euler2() {
        //   velocity =
        //     animated.lastVelocity !== void 0 ? animated.lastVelocity : v0

        //   const dt =
        //     config.config.dt > 20
        //       ? config.config.dt / config.w0 / 1000
        //       : config.config.dt
        //   const numSteps = Math.ceil(step / dt)
        //   for (let n = 0; n < numSteps; ++n) {
        //     const acceleration =
        //       ((-config.tension! / 1000000) * (position - to)) / config.mass! // f = a * m <=> a = f / m
        //     velocity =
        //       (velocity + acceleration * dt) *
        //       Math.pow(1 - config.friction! / 100, dt)
        //     position = position + velocity * dt
        //   }
        // }
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
          // case 'euler2':
          //   euler2()
          //   break
          default:
            analytical()
        }

        const t1 = performance.now()
        animated.performance = t1 - t0

        // Conditions for stopping the spring animation
        const isBouncing =
          config.clamp !== false && config.tension !== 0
            ? from < to
              ? position > to && velocity > 0
              : position < to && velocity < 0
            : false

        if (isBouncing) {
          velocity =
            -velocity * (typeof config.clamp! === 'number' ? config.clamp! : 0)
        }

        const isVelocity = Math.abs(velocity) <= precision
        const isDisplacement =
          config.tension !== 0 ? Math.abs(to - position) <= precision : true

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
    }

    if (changes && changed) {
      changes.push([config.key, config.animated.getValue()])
    }

    return active
  }
}
