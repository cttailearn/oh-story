import { NavLink, Outlet, Link, useNavigate } from 'react-router-dom';

export function AppShell() {
  const navigate = useNavigate();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-seal">oh·</span>story 编辑部
        </Link>
        <span className="spacer" />
        <nav>
          <NavLink to="/">书房</NavLink>
          <NavLink to="/modules">模块库</NavLink>
          <NavLink to="/export">导出</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
      </header>
      <div className="shell-main">
        <SideNav />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SideNav() {
  return (
    <nav className="side-nav">
      <NavLink to="/" title="书房">
        📚
      </NavLink>
      <NavLink to="/settings" title="设置">
        ⚙
      </NavLink>
      <NavLink to="/modules" title="模块库">
        🧩
      </NavLink>
    </nav>
  );
}
