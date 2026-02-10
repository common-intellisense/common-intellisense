<template>
  <a-space direction="vertical" :size="16">
    <a-typography-title :level="4">Antdv Next Demo</a-typography-title>
    <a-button type="primary" @click="count++">
      Clicked {{ count }} times
    </a-button>

    <a-input v-model:value="keyword" placeholder="Search keyword" allow-clear />

    <a-select v-model:value="size" style="width: 180px">
      <a-select-option value="small">Small</a-select-option>
      <a-select-option value="middle">Middle</a-select-option>
      <a-select-option value="large">Large</a-select-option>
    </a-select>

    <a-alert message="Success Text" type="success" show-icon />
  </a-space>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Alert, Button, Input, Select, Space, Typography } from 'antdv-next'

const count = ref(0)
const keyword = ref('')
const size = ref<'small' | 'middle' | 'large'>('middle')
</script>
