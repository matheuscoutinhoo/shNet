import { Component, Suspense, type ReactNode } from 'react';
import { Modal } from '../components/Modal';
export class DeferredPanel extends Component<
  { children: ReactNode; onClose: () => void; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <Modal title="Painel indisponível" onClose={this.props.onClose}>
          <p>
            Não foi possível carregar este painel. Feche-o e salve ou exporte o laboratório antes de
            recarregar a página.
          </p>
          <button className="button" onClick={this.props.onClose}>
            Fechar painel
          </button>
        </Modal>
      );
    return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
  }
}
