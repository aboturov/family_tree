import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type User } from './api.ts';
import { ChunkErrorBoundary } from './ChunkErrorBoundary.tsx';
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
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={pending}>Войти</button>
      </form>
    </main>
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
        <label>
          Временный пароль
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          Новый пароль
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </label>
        <label>
          Повторите новый пароль
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
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

  useEffect(() => {
    api
      .tree()
      .then(setTree)
      .catch(() => setError('Не удалось загрузить дерево'));
  }, []);
  const editing = useMemo(
    () => ({
      canEdit: user.role === 'admin' || user.role === 'editor',
      reload: () => api.tree().then(setTree),
    }),
    [user.role],
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
        : 'tree';

  let content;
  if (error) content = <p className="placeholder">{error}</p>;
  else if (!tree || !index) content = <p className="placeholder">Загружаем дерево…</p>;
  else if (page === 'person')
    content = <PersonPage personId={Number(personMatch![1])} index={index} meId={user.personId} />;
  else if (page === 'people') content = <PeoplePage tree={tree} />;
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
        <EditingProvider value={editing}>{content}</EditingProvider>
      </div>
    </div>
  );
}
