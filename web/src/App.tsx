import { lazy, Suspense, useEffect, useId, useMemo, useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { api, ApiError, type DocumentInput, type DocumentView, type User } from './api.ts';
import { ChunkErrorBoundary } from './ChunkErrorBoundary.tsx';
import { DocumentDialog } from './documents/DocumentDialog.tsx';
import { DocumentsProvider, type Documents } from './documents/DocumentsContext.ts';
import { DocumentsPage } from './documents/DocumentsPage.tsx';
import { EditingProvider } from './editing/EditingContext.ts';
import { HistoryPage } from './HistoryPage.tsx';
import { PeoplePage } from './PeoplePage.tsx';
import { PersonPage } from './PersonPage.tsx';
import { Link, useLocation } from './router.ts';
import { indexTree, type Tree } from './tree/model.ts';

// Схема дерева тянет за собой ELK (~1,5 МБ) — грузим её только на странице дерева.
const TreePage = lazy(() => import('./tree/TreePage.tsx'));

type Session = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setSession({ status: 'authenticated', user }))
      .catch(() => setSession({ status: 'anonymous' }));
  }, []);

  if (session.status === 'loading') return null;
  if (session.status === 'anonymous') {
    return <LoginPage onLogin={(user) => setSession({ status: 'authenticated', user })} />;
  }
  if (session.user.mustChangePassword) {
    return <ChangePasswordPage onChanged={(user) => setSession({ status: 'authenticated', user })} />;
  }
  return <HomePage user={session.user} onLogout={() => setSession({ status: 'anonymous' })} />;
}

function useSubmit() {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const submit = async (action: () => Promise<void>) => {
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Сервер недоступен, попробуйте позже');
    } finally {
      setPending(false);
    }
  };

  return { error, pending, submit };
}

function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const { error, pending, submit } = useSubmit();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(async () => onLogin((await api.login(login, password)).user));
  };

  return (
    <main className="auth">
      <form className="card" onSubmit={onSubmit}>
        <h1>Семейное древо</h1>
        <label>
          Логин
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <PasswordField
          label="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error && <p className="error">{error}</p>}
        <button disabled={pending}>Войти</button>
      </form>
    </main>
  );
}

// Поле пароля с глазком. Подпись связана через id, а не обёрткой: иначе подпись кнопки
// попала бы в имя поля для скринридера («Пароль Показать пароль»).
function PasswordField({ label, ...props }: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const toggleLabel = visible ? 'Скрыть пароль' : 'Показать пароль';

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-field">
        {/* Открытый пароль — обычное текстовое поле: без этого телефон поправит или сделает заглавной первую букву. */}
        <input
          {...props}
          id={id}
          type={visible ? 'text' : 'password'}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <EyeIcon crossed={visible} />
        </button>
      </div>
    </div>
  );
}

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M1.75 10s3-5.75 8.25-5.75S18.25 10 18.25 10 15.25 15.75 10 15.75 1.75 10 1.75 10Z" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.75" />
      {crossed && <path d="m3.5 3.5 13 13" strokeLinecap="round" />}
    </svg>
  );
}

function ChangePasswordPage({ onChanged }: { onChanged: (user: User) => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const { error, pending, submit } = useSubmit();
  const mismatch = repeat !== '' && repeat !== newPassword;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    submit(async () => onChanged((await api.changePassword(currentPassword, newPassword)).user));
  };

  return (
    <main className="auth">
      <form className="card" onSubmit={onSubmit}>
        <h1>Смена пароля</h1>
        <p className="hint">Вы вошли с временным паролем. Придумайте свой — не короче 10 символов.</p>
        <PasswordField
          label="Временный пароль"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <PasswordField
          label="Новый пароль"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          minLength={10}
          required
        />
        <PasswordField
          label="Повторите новый пароль"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          autoComplete="new-password"
          required
        />
        {mismatch && <p className="error">Пароли не совпадают</p>}
        {error && <p className="error">{error}</p>}
        <button disabled={pending || mismatch}>Сохранить</button>
      </form>
    </main>
  );
}

function HomePage({ user, onLogout }: { user: User; onLogout: () => void }) {
  const location = useLocation();
  const [tree, setTree] = useState<Tree>();
  const [error, setError] = useState<string>();
  const index = useMemo(() => tree && indexTree(tree), [tree]);
  const [documents, setDocuments] = useState<Map<number, DocumentView>>();
  const [documentsError, setDocumentsError] = useState<string>();
  // Открытое окно документа: существующий или новый (с заготовкой).
  const [opened, setOpened] = useState<{ id: number } | { id: null; preset?: Partial<DocumentInput> } | null>(null);

  const loadDocuments = () =>
    api.documents().then(({ documents }) => {
      setDocuments(new Map(documents.map((d) => [d.id, d])));
      setDocumentsError(undefined);
    });
  useEffect(() => {
    api
      .tree()
      .then(setTree)
      .catch(() => setError('Не удалось загрузить дерево'));
    loadDocuments().catch(() => setDocumentsError('Не удалось загрузить документы'));
  }, []);
  // Правка людей и событий меняет и документы (связи снимаются вместе с удалёнными), поэтому
  // после любой правки обновляем и то, и другое.
  const editing = useMemo(
    () => ({
      canEdit: user.role === 'admin' || user.role === 'editor',
      reload: () => Promise.all([api.tree().then(setTree), loadDocuments()]).then(() => {}),
    }),
    [user.role],
  );
  const documentsValue = useMemo<Documents>(
    () => ({
      byId: documents,
      error: documentsError,
      open: (id) => setOpened({ id }),
      create: (preset) => setOpened({ id: null, preset }),
    }),
    [documents, documentsError],
  );

  const logout = async () => {
    await api.logout().catch(() => {});
    onLogout();
  };

  const personMatch = /^\/person\/(\d+)$/.exec(location.pathname);
  const page = personMatch
    ? 'person'
    : location.pathname === '/people'
      ? 'people'
      : location.pathname === '/history'
        ? 'history'
        : location.pathname === '/documents'
          ? 'documents'
          : 'tree';

  let content;
  if (error) content = <p className="placeholder">{error}</p>;
  else if (!tree || !index) content = <p className="placeholder">Загружаем дерево…</p>;
  else if (page === 'person')
    content = <PersonPage personId={Number(personMatch![1])} index={index} meId={user.personId} />;
  else if (page === 'people') content = <PeoplePage tree={tree} />;
  else if (page === 'documents') content = <DocumentsPage index={index} />;
  else if (page === 'history') {
    const person = Number(location.searchParams.get('person')) || undefined;
    content = <HistoryPage key={person} index={index} user={user} personId={person} />;
  }
  else
    content = (
      <ChunkErrorBoundary>
        <Suspense fallback={<p className="placeholder">Загружаем дерево…</p>}>
          <TreePage tree={tree} index={index} meId={user.personId} />
        </Suspense>
      </ChunkErrorBoundary>
    );

  return (
    <div className={page === 'tree' ? 'app app-fixed' : 'app'}>
      <header className="topbar">
        <Link to="/" className="brand">
          Семейное древо
        </Link>
        <nav className="nav">
          <Link to="/" className={page === 'tree' ? 'active' : ''}>
            Древо
          </Link>
          <Link to="/people" className={page === 'people' ? 'active' : ''}>
            Люди
          </Link>
          <Link to="/documents" className={page === 'documents' ? 'active' : ''}>
            Документы
          </Link>
          <Link to="/history" className={page === 'history' ? 'active' : ''}>
            История
          </Link>
        </nav>
        <span className="who">
          <span className="who-login">{user.login}</span>
          <button className="link" onClick={logout}>
            Выйти
          </button>
        </span>
      </header>
      <div className="app-main">
        <EditingProvider value={editing}>
          <DocumentsProvider value={documentsValue}>
            {content}
            {opened && index && documents && (opened.id === null || documents.has(opened.id)) && (
              <DocumentDialog
                key={opened.id ?? 'new'}
                document={opened.id === null ? undefined : documents.get(opened.id)}
                preset={opened.id === null ? opened.preset : undefined}
                index={index}
                all={[...documents.values()]}
                onClose={() => setOpened(null)}
                onCreated={(id) => setOpened({ id })}
              />
            )}
          </DocumentsProvider>
        </EditingProvider>
      </div>
    </div>
  );
}
