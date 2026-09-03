import React from 'react';

interface SylorLogoProps {
  className?: string;
  size?: number;
  showBubbles?: boolean;
}

export const SylorLogo: React.FC<SylorLogoProps> = ({
  className = '',
  size = 28,
  showBubbles = true,
}) => {
  return (
    <div
      className={`relative inline-flex items-center justify-center select-none ${className}`}
      style={{ width: size, height: size }}
      aria-label="Sylor Mascot Logo"
    >
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full overflow-visible"
      >
        {/* Floating Bubbles on top-right */}
        {showBubbles && (
          <g className="transition-transform duration-300 group-hover:translate-y-[-1px]">
            {/* Top smallest bubble */}
            <circle
              cx="80"
              cy="25"
              r="4.5"
              stroke="#e7644d"
              strokeWidth="2.75"
              fill="none"
            />
            {/* Middle medium bubble */}
            <circle
              cx="88"
              cy="38"
              r="6.5"
              stroke="#e7644d"
              strokeWidth="3.2"
              fill="none"
            />
            {/* Bottom largest bubble */}
            <circle
              cx="77"
              cy="52"
              r="8.5"
              stroke="#e7644d"
              strokeWidth="3.5"
              fill="none"
            />
          </g>
        )}

        {/* Main Ghost/Octopus Body */}
        <g id="sylor-mascot-body">
          {/* Main Body Path with rounded dome and wavy bottom tentacles */}
          <path
            d="M 18 54 
               C 18 24, 32 10, 52 10 
               C 72 10, 86 24, 86 54 
               C 86 70, 85 86, 85 88 
               C 83 83, 79 78, 75 88 
               C 71 78, 67 78, 63 88 
               C 59 78, 55 78, 52 92 
               C 49 78, 45 78, 41 88 
               C 37 78, 33 78, 29 88 
               C 25 78, 21 83, 19 88 
               C 19 86, 18 70, 18 54 Z"
            fill="#e7644d"
          />

          {/* Upper Left Glossy Highlight */}
          <ellipse
            cx="34"
            cy="24"
            rx="8.5"
            ry="5"
            transform="rotate(-25 34 24)"
            fill="#ffffff"
            opacity="0.32"
          />

          {/* Left Eye */}
          <ellipse cx="40" cy="51" rx="6.5" ry="7.5" fill="#ffffff" />
          <circle cx="41.5" cy="51" r="3.2" fill="#141413" />

          {/* Right Eye */}
          <ellipse cx="64" cy="51" rx="6.5" ry="7.5" fill="#ffffff" />
          <circle cx="65.5" cy="51" r="3.2" fill="#141413" />

          {/* Friendly Smile */}
          <path
            d="M 46 64 C 48 70, 56 70, 58 64"
            stroke="#ffffff"
            strokeWidth="3.2"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      </svg>
    </div>
  );
};
