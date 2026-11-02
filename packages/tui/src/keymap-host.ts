import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui"
import { Keymap } from "@opentui/keymap"
import { registerDefaultKeys, registerEnabledFields, registerMetadataFields } from "@opentui/keymap/addons"
import { RenderableEvents, type CliRenderer } from "@opentui/core"

// keymap は「同じ画面部品に重ねたキー割り当て層」ごとに destroyed 購読を1つ足す。
// 入力欄などには正当に11層以上重なるため、既定上限10を超えると起動のたびに
// MaxListenersExceededWarning が画面下に出ていた(リークではない: 層の解除時に off される)。
// 購読数に合わせて上限だけ引き上げ、それ以外は createDefaultOpenTuiKeymap と同じ構成にする。
export function createSenteKeymap(renderer: CliRenderer) {
  if (renderer.isDestroyed) throw new Error("Cannot create a keymap for a destroyed renderer")
  const host = createOpenTuiKeymapHost(renderer)
  const onTargetDestroy = host.onTargetDestroy.bind(host)
  host.onTargetDestroy = (target, listener) => {
    const needed = target.listenerCount(RenderableEvents.DESTROYED) + 1
    const max = target.getMaxListeners()
    if (max !== 0 && needed > max) target.setMaxListeners(Math.max(needed, max * 2))
    return onTargetDestroy(target, listener)
  }
  const keymap = new Keymap(host)
  registerDefaultKeys(keymap)
  registerEnabledFields(keymap)
  registerMetadataFields(keymap)
  return keymap
}
