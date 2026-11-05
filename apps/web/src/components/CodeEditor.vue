<script setup lang="ts">
import { go } from "@codemirror/lang-go";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ScriptRuntime } from "../types";

const props = withDefaults(defineProps<{ language?: ScriptRuntime; label?: string }>(), { language: "javascript", label: "Script" });
const model = defineModel<string>({ required: true });
const host = ref<HTMLDivElement | null>(null);
const languageSlot = new Compartment();
let editor: EditorView | null = null;

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: "#c7a6ff" },
  { tag: [tags.string, tags.special(tags.string)], color: "#a5d6a7" },
  { tag: [tags.number, tags.bool, tags.null], color: "#f2c37b" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#7c8590" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#8ec5ff" },
  { tag: [tags.propertyName], color: "#d7dde6" },
  { tag: [tags.typeName, tags.className], color: "#f0a3c2" },
  { tag: [tags.variableName, tags.name], color: "#e8ecf1" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "#aab4bf" },
]);

function languageFor(runtime: ScriptRuntime) {
  if (runtime === "python") return python();
  if (runtime === "go") return go();
  return javascript();
}

onMounted(() => {
  if (!host.value) return;
  editor = new EditorView({
    doc: model.value,
    extensions: [
      basicSetup,
      languageSlot.of(languageFor(props.language)),
      syntaxHighlighting(highlight),
      EditorView.contentAttributes.of({ "aria-label": props.label }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) model.value = update.state.doc.toString();
      }),
    ],
    parent: host.value,
  });
});

watch(model, (value) => {
  if (!editor || editor.state.doc.toString() === value) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
});

watch(
  () => props.language,
  (runtime) => editor?.dispatch({ effects: languageSlot.reconfigure(languageFor(runtime)) }),
);

onBeforeUnmount(() => editor?.destroy());
</script>

<template>
  <div ref="host" class="code-editor"></div>
</template>
