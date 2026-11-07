import vue from 'eslint-plugin-vue';
import globals from 'globals';

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
};

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  ...vue.configs['flat/base'],
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: { 'no-undef': 'error', 'vue/no-undef-properties': 'error' },
  },
  {
    files: ['src/use-*.js'],
    languageOptions: { globals: globals.browser },
    rules,
  },
  {
    files: [
      'server/index.js', 'server/*-routes.js', 'server/http-response.js',
      'server/*-platform.js', 'server/multi-platform-recorder.js', 'server/room-lookup.js',
      'server/app-activity.js', 'server/workbench-snapshot.js', 'server/app-lifecycle.js',
    ],
    languageOptions: { globals: globals.node },
    rules,
  },
];
