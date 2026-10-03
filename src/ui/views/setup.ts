import type { UI, View } from '../app';
import { h, replace } from '../dom';

function nameForm(ui: UI, onDone: () => void, submitLabel: string): HTMLFormElement {
  const input = h('input', { id: 'author-name', name: 'author', type: 'text', autocomplete: 'name', required: true, maxlength: '80', value: ui.ctl.author, 'aria-describedby': 'author-help' });
  const err = h('p', { id: 'author-err', class: 'field-error', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: (e: Event) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) {
          err.textContent = 'Indique o seu nome.';
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return;
        }
        ui.ctl.setAuthor(v);
        onDone();
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'author-name' }, 'O seu nome'), input, h('p', { id: 'author-help', class: 'hint' }, 'Aparece no histórico de alterações. Fica guardado só neste PC.'), err),
    h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel),
  );
  return form;
}

export function setupView(ui: UI, main: HTMLElement): View {
  const render = () => {
    const c = ui.ctl;
    const steps: HTMLElement[] = [];
    if (!c.author) {
      steps.push(h('section', { 'aria-labelledby': 'st1' }, h('h3', { id: 'st1' }, 'Passo 1 — Identifique-se'), nameForm(ui, () => render(), 'Continuar')));
    } else {
      const status = h('div', { role: 'status', 'aria-live': 'polite', class: 'pick-status' });
      const pickFull = async () => {
        status.textContent = 'A abrir o seletor de pastas…';
        const r = await c.pickFolderFull();
        if (r.ok) return;
        if (r.reason === 'cancelled') status.textContent = 'Seleção cancelada.';
        else if (r.reason === 'not-app-folder' && r.handle) {
          const ok = await ui.confirmDialog(
            'Esta pasta não parece ser a RegistoGravidas',
            `A pasta «${r.handle.name}» não tem a subpasta "data" nem o ficheiro index.html. Se é mesmo esta (pasta nova e vazia), a aplicação cria a estrutura. Caso contrário, cancele e escolha a pasta RegistoGravidas.`,
            'Usar esta pasta',
          );
          if (ok) await c.adoptHandle(r.handle);
          else status.textContent = 'Escolha a pasta RegistoGravidas.';
        } else {
          status.textContent = `Não foi possível usar o acesso direto à pasta (${r.error ?? r.reason}). Use o modo compatível abaixo.`;
          render();
        }
      };
      const fullAvailable = c.caps.directoryPicker && !c.pickerError;
      steps.push(
        h(
          'section',
          { 'aria-labelledby': 'st2' },
          h('h3', { id: 'st2' }, 'Passo 2 — Escolha a pasta RegistoGravidas'),
          h('p', null, 'É a pasta partilhada do OneDrive onde está este ficheiro index.html (normalmente em OneDrive › RegistoGravidas).'),
          c.storedHandle
            ? h('p', null, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void ui.reconnect() }, `Continuar com a pasta «${c.storedHandle.name}»`))
            : null,
          fullAvailable
            ? h(
                'div',
                { class: 'card' },
                h('h4', null, 'Recomendado: acesso direto'),
                h('p', null, 'A aplicação lê e grava diretamente na pasta e atualiza sozinha a cada 20 segundos. O browser vai pedir autorização para "ver e editar" a pasta — aceite.'),
                h('button', { type: 'button', class: 'btn btn-primary', id: 'pick-full', onclick: () => void pickFull() }, 'Escolher pasta RegistoGravidas'),
              )
            : h('p', { class: 'banner banner-warn' }, 'O acesso direto a pastas não está disponível neste browser ', c.pickerError ? `(${c.pickerError})` : '(API ausente ou bloqueada)', '. Use o modo compatível.'),
          h(
            'div',
            { class: 'card' },
            h('h4', null, fullAvailable ? 'Alternativa: modo compatível' : 'Modo compatível'),
            h('p', null, 'Para PCs onde o acesso direto está bloqueado. O browser lê a pasta quando a seleciona (pode pedir confirmação para "carregar" ficheiros — nada sai do PC). Cada gravação descarrega um pequeno ficheiro que tem de mover para RegistoGravidas\\data\\events.'),
            h('button', { type: 'button', class: 'btn', id: 'pick-compat', onclick: () => ui.openCompatPicker() }, 'Selecionar pasta (modo compatível)'),
          ),
          status,
        ),
      );
    }
    replace(
      main,
      h('h2', null, 'Primeira utilização'),
      h('p', null, 'Esta aplicação guarda os registos na pasta partilhada do OneDrive. Não instala nada e funciona sem internet.'),
      ...steps,
      h('p', null, h('a', { href: '#/diagnostico' }, 'Ver diagnóstico do browser')),
    );
  };
  render();
  return { title: 'Primeira utilização', update: render };
}

export function userView(ui: UI, main: HTMLElement): View {
  replace(main, h('h2', null, 'Utilizador'), nameForm(ui, () => ui.go('#/registos'), 'Guardar'));
  return { title: 'Utilizador' };
}
