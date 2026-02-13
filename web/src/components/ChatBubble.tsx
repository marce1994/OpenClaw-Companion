import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage } from '../protocol/types';
import './ChatBubble.css';

interface Props {
  message: ChatMessage;
  onButtonClick?: (callbackData: string) => void;
}

export function ChatBubble({ message, onButtonClick }: Props) {
  const isUser = message.role === 'user';

  return (
    <div className={`bubble-row ${isUser ? 'user' : 'assistant'}`}>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}`}>
        {isUser ? (
          <p>{message.text}</p>
        ) : (
          <ReactMarkdown
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const code = String(children).replace(/\n$/, '');

                if (match) {
                  return (
                    <SyntaxHighlighter
                      style={oneDark}
                      language={match[1]}
                      PreTag="div"
                    >
                      {code}
                    </SyntaxHighlighter>
                  );
                }
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {message.text.replace(/\[\[emotion:\w+\]\]/g, '')}
          </ReactMarkdown>
        )}

        {message.artifact && (
          <div className="artifact">
            <div className="artifact-header">
              📄 {message.artifact.title}
              <span className="artifact-lang">{message.artifact.language}</span>
            </div>
            <SyntaxHighlighter
              style={oneDark}
              language={message.artifact.language}
              PreTag="div"
            >
              {message.artifact.content}
            </SyntaxHighlighter>
          </div>
        )}

        {message.buttons && message.buttons.length > 0 && (
          <div className="buttons">
            {message.buttons.map((btn, i) => (
              <button
                key={i}
                className="inline-button"
                onClick={() => onButtonClick?.(btn.callback_data || btn.value || btn.text)}
              >
                {btn.text}
              </button>
            ))}
          </div>
        )}

        <span className="timestamp">
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
    </div>
  );
}
