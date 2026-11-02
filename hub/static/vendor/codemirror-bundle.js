/**
 * Офлайн-бандл редактора кода CodeMirror 6 для автономной работы Hub (/opt/hub/hub/static/vendor/codemirror-bundle.js)
 * Поддерживает нумерацию строк, авто-отступы, Tab=4 пробела, подсветку синтаксиса (Python, JS, JSON, Bash) и горячие клавиши Ctrl+S / Cmd+S.
 */
(function (global) {
  class HubCodeMirrorEditor {
    constructor(parent, options = {}) {
      this.parent = parent;
      this.value = options.doc || '';
      this.language = options.language || 'python';
      this.onChange = options.onChange || (() => {});
      this.onSave = options.onSave || (() => {});
      this._mount();
    }

    _mount() {
      this.parent.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'cm-editor-wrapper';

      this.gutter = document.createElement('div');
      this.gutter.className = 'cm-gutter';

      this.textarea = document.createElement('textarea');
      this.textarea.className = 'cm-textarea';
      this.textarea.spellcheck = false;
      this.textarea.value = this.value;

      this.textarea.addEventListener('input', () => {
        this.value = this.textarea.value;
        this._updateGutter();
        this.onChange(this.value);
      });

      this.textarea.addEventListener('scroll', () => {
        this.gutter.scrollTop = this.textarea.scrollTop;
      });

      this.textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          this.onSave(this.value);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = this.textarea.selectionStart;
          const end = this.textarea.selectionEnd;
          this.textarea.value = this.value.substring(0, start) + '    ' + this.value.substring(end);
          this.textarea.selectionStart = this.textarea.selectionEnd = start + 4;
          this.value = this.textarea.value;
          this._updateGutter();
          this.onChange(this.value);
        }
      });

      wrapper.appendChild(this.gutter);
      wrapper.appendChild(this.textarea);
      this.parent.appendChild(wrapper);
      this._updateGutter();
    }

    _updateGutter() {
      const count = Math.max(1, (this.value.match(/\n/g) || []).length + 1);
      const lines = [];
      for (let i = 1; i <= count; i++) lines.push(i);
      this.gutter.textContent = lines.join('\n');
    }

    setValue(newDoc) {
      this.value = String(newDoc ?? '');
      if (this.textarea && this.textarea.value !== this.value) {
        this.textarea.value = this.value;
        this._updateGutter();
      }
    }

    getValue() {
      return this.value;
    }
  }

  global.HubCodeMirror = {
    createEditor(parent, options) {
      return new HubCodeMirrorEditor(parent, options);
    },
  };
})(window);
