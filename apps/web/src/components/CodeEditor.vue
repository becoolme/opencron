<script setup lang="ts">
import { javascript } from "@codemirror/lang-javascript";
import { basicSetup, EditorView } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const model = defineModel<string>({ required: true });
const host = ref<HTMLDivElement | null>(null);
let editor: EditorView | null = null;

onMounted(() => {
  if (!host.value) return;

  editor = new EditorView({
    doc: model.value,
    extensions: [
      basicSetup,
      javascript(),
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

onBeforeUnmount(() => editor?.destroy());
</script>

<template>
  <div ref="host" class="code-editor border rounded overflow-hidden font-mono text-sm"></div>
</template>
