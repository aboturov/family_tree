import { photoUrl } from './api.ts';
import { avatarImageBox } from './avatarGeometry.ts';
import { awardsOf, awardTitle, type Person } from './tree/model.ts';

// Силуэт-заглушка вместо фото, в координатах круга 100×100. Пара на общей основе: голова
// и плечи, переходящие из шеи плавной дугой; волосы на тон темнее — у мужского короткая
// стрижка с пробором, у женского каре с чёлкой, плечи чуть уже.
export function SilhouetteShapes({ sex }: { sex: Person['sex'] }) {
  if (sex === 'F') {
    return (
      <g className="silhouette">
        <path
          className="hair"
          d="M30 43 C28 22 38 15 50 15 C62 15 72 22 70 43 C69 52 71 58 76 62 C68 65 60 61 58 56 L42 56 C40 61 32 65 24 62 C29 58 31 52 30 43 Z"
        />
        <ellipse cx={50} cy={38} rx={16} ry={18} />
        <path className="hair" d="M34 36 C34 23 42 18 50 18 C58 18 66 23 66 36 C61 30 56 27 50 27 C44 29 38 31 34 36 Z" />
        <path d="M41 52 C41 58 38 62 33 64 C21 68 14 78 14 104 L86 104 C86 78 79 68 67 64 C62 62 59 58 59 52 Z" />
      </g>
    );
  }
  return (
    <g className="silhouette">
      <ellipse cx={50} cy={38} rx={17} ry={19} />
      <path
        className="hair"
        d="M33 38 C31 22 40 15 50 15 C61 15 69 22 67 38 L66 38 C65 31 63 28 60 27 C53 29 45 28 40 25 C38 28 35 32 34 38 Z"
      />
      <path d="M39 52 C39 58 36 62 30 64 C17 68 9 78 9 104 L91 104 C91 78 83 68 70 64 C64 62 61 58 61 52 Z" />
    </g>
  );
}

/** Содержимое круга 100×100: кадрированное фото-аватарка или силуэт. Клип — снаружи. */
export function AvatarContent({ person }: { person: Person }) {
  const photo = person.avatar && person.photos.find((p) => p.id === person.avatar!.mediaId);
  if (!person.avatar || !photo) return <SilhouetteShapes sex={person.sex} />;
  const box = avatarImageBox(person.avatar.crop, photo, 100);
  return (
    <image
      href={photoUrl(photo.id, 'thumb')}
      x={box.x}
      y={box.y}
      width={box.width}
      height={box.height}
      preserveAspectRatio="none"
    />
  );
}

// Медаль: колодка с лентой и диск со звездой, в своих координатах 10×20.
function MedalShapes() {
  return (
    <>
      <path className="medal-ribbon" d="M0 0h10v7l-5 3-5-3z" />
      <path className="medal-stripe" d="M4 0h2v8.8l-1 .6-1-.6z" />
      <circle className="medal-disk" cx={5} cy={15} r={5} />
      <path
        className="medal-star"
        d="M5 12l.73 1.99 2.12.08-1.66 1.32.57 2.04L5 16.25l-1.76 1.18.57-2.04-1.66-1.32 2.12-.08z"
      />
    </>
  );
}

/** Медаль на груди аватарки, если у человека есть награды; в подсказке — какие. */
export function AvatarMedal({ person }: { person: Person }) {
  const awards = awardsOf(person);
  if (!awards.length) return null;
  // Носят слева на груди — со стороны зрителя справа, под плечом и над плашкой родства в дереве.
  return (
    <g className="avatar-medal" transform="translate(60.5 67) scale(0.85)">
      <title>{`Награды: ${awards.map(awardTitle).join(', ')}`}</title>
      <MedalShapes />
    </g>
  );
}

/** Значок перед списком наград. */
export function MedalIcon({ size = 18 }: { size?: number }) {
  return (
    <svg className="medal-icon" width={(size * 11) / 21} height={size} viewBox="-0.5 -0.5 11 21" role="img" aria-label="Награды">
      <MedalShapes />
    </svg>
  );
}

/** Круглый аватар для страниц (в дереве он рисуется внутри общего SVG). */
export function Avatar({ person, size }: { person: Person; size: number }) {
  const clipId = `avatar-${person.id}-${size}`;
  return (
    <svg className="avatar" width={size} height={size} viewBox="-2 -2 104 104" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <circle cx={50} cy={50} r={49} />
        </clipPath>
      </defs>
      <circle className="avatar-bg" cx={50} cy={50} r={50} />
      <g clipPath={`url(#${clipId})`}>
        <AvatarContent person={person} />
      </g>
      <AvatarMedal person={person} />
    </svg>
  );
}
