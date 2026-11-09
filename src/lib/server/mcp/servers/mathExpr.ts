/**
 * A small, safe arithmetic expression evaluator (no `eval`). Grammar, loosest
 * binding first:
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := ('+' | '-') unary | power
 *   power   := postfix (('^' | '**') unary)?     right-associative, so -2^2 = -4
 *   postfix := primary '!'*
 *   primary := number | constant | function '(' args ')' | '(' expr ')'
 */

export class MathExprError extends Error {}

type Fn = { arity: [min: number, max: number]; run: (...args: number[]) => number };

function factorial(n: number): number {
	if (!Number.isInteger(n) || n < 0)
		throw new MathExprError('factorial needs a non-negative integer');
	if (n > 170) return Infinity;
	let out = 1;
	for (let i = 2; i <= n; i++) out *= i;
	return out;
}

function gcd(a: number, b: number): number {
	if (!Number.isInteger(a) || !Number.isInteger(b)) throw new MathExprError('gcd needs integers');
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) [x, y] = [y, x % y];
	return x;
}

function lcm(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return Math.abs(a / gcd(a, b)) * Math.abs(b);
}

function choose(n: number, k: number): number {
	if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0) {
		throw new MathExprError('nCr needs non-negative integers');
	}
	if (k > n) return 0;
	let out = 1;
	for (let i = 1; i <= Math.min(k, n - k); i++) out = (out * (n - i + 1)) / i;
	return Math.round(out);
}

const one = (run: (x: number) => number): Fn => ({ arity: [1, 1], run });
const variadic = (run: (...xs: number[]) => number): Fn => ({ arity: [1, Infinity], run });

const FUNCTIONS: Record<string, Fn> = {
	sqrt: one(Math.sqrt),
	cbrt: one(Math.cbrt),
	abs: one(Math.abs),
	sign: one(Math.sign),
	floor: one(Math.floor),
	ceil: one(Math.ceil),
	trunc: one(Math.trunc),
	round: {
		arity: [1, 2],
		run: (x, places = 0) => {
			const factor = 10 ** places;
			return Math.round(x * factor) / factor;
		}
	},
	exp: one(Math.exp),
	ln: one(Math.log),
	log10: one(Math.log10),
	log2: one(Math.log2),
	log: {
		arity: [1, 2],
		run: (x, base) => (base === undefined ? Math.log(x) : Math.log(x) / Math.log(base))
	},
	sin: one(Math.sin),
	cos: one(Math.cos),
	tan: one(Math.tan),
	asin: one(Math.asin),
	acos: one(Math.acos),
	atan: one(Math.atan),
	atan2: { arity: [2, 2], run: Math.atan2 },
	sinh: one(Math.sinh),
	cosh: one(Math.cosh),
	tanh: one(Math.tanh),
	deg: one((x) => (x * 180) / Math.PI),
	rad: one((x) => (x * Math.PI) / 180),
	pow: { arity: [2, 2], run: (a, b) => a ** b },
	mod: { arity: [2, 2], run: (a, b) => a % b },
	hypot: variadic(Math.hypot),
	min: variadic(Math.min),
	max: variadic(Math.max),
	factorial: one(factorial),
	gcd: { arity: [2, Infinity], run: (...xs) => xs.reduce(gcd) },
	lcm: { arity: [2, Infinity], run: (...xs) => xs.reduce(lcm) },
	ncr: { arity: [2, 2], run: choose }
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

export const MATH_FUNCTION_NAMES = Object.keys(FUNCTIONS);

type Token =
	| { kind: 'num'; value: number; pos: number }
	| { kind: 'ident'; value: string; pos: number }
	| { kind: 'op'; value: string; pos: number };

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
		if (num) {
			tokens.push({ kind: 'num', value: Number(num[0]), pos: i });
			i += num[0].length;
			continue;
		}
		const ident = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
		if (ident) {
			tokens.push({ kind: 'ident', value: ident[0].toLowerCase(), pos: i });
			i += ident[0].length;
			continue;
		}
		if (src.startsWith('**', i)) {
			tokens.push({ kind: 'op', value: '^', pos: i });
			i += 2;
			continue;
		}
		if ('+-*/%^!(),'.includes(ch)) {
			tokens.push({ kind: 'op', value: ch, pos: i });
			i++;
			continue;
		}
		throw new MathExprError(`unexpected character "${ch}" at position ${i + 1}`);
	}
	return tokens;
}

/** Evaluates an arithmetic expression such as `2^10 / (3 + sqrt(16)) * 5%3`. */
export function evaluateExpression(src: string): number {
	const tokens = tokenize(src);
	let pos = 0;

	const peek = () => tokens[pos];
	const isOp = (value: string) => {
		const t = tokens[pos];
		return t?.kind === 'op' && t.value === value;
	};
	const expect = (value: string) => {
		if (!isOp(value)) {
			const t = tokens[pos];
			throw new MathExprError(
				t ? `expected "${value}" at position ${t.pos + 1}` : `expected "${value}" at end`
			);
		}
		pos++;
	};

	function expr(): number {
		let left = term();
		while (isOp('+') || isOp('-')) {
			const op = tokens[pos++].value;
			const right = term();
			left = op === '+' ? left + right : left - right;
		}
		return left;
	}

	function term(): number {
		let left = unary();
		while (isOp('*') || isOp('/') || isOp('%')) {
			const op = tokens[pos++].value;
			const right = unary();
			if (op === '*') left *= right;
			else if (right === 0)
				throw new MathExprError(op === '/' ? 'division by zero' : 'modulo by zero');
			else left = op === '/' ? left / right : left % right;
		}
		return left;
	}

	function unary(): number {
		if (isOp('-')) {
			pos++;
			return -unary();
		}
		if (isOp('+')) {
			pos++;
			return unary();
		}
		return power();
	}

	function power(): number {
		const base = postfix();
		if (isOp('^')) {
			pos++;
			return base ** unary();
		}
		return base;
	}

	function postfix(): number {
		let value = primary();
		while (isOp('!')) {
			pos++;
			value = factorial(value);
		}
		return value;
	}

	function primary(): number {
		const t = peek();
		if (!t) throw new MathExprError('unexpected end of expression');
		if (t.kind === 'num') {
			pos++;
			return t.value;
		}
		if (t.kind === 'ident') {
			pos++;
			if (isOp('(')) {
				const fn = FUNCTIONS[t.value];
				if (!fn) throw new MathExprError(`unknown function "${t.value}"`);
				pos++;
				const args: number[] = [];
				if (!isOp(')')) {
					args.push(expr());
					while (isOp(',')) {
						pos++;
						args.push(expr());
					}
				}
				expect(')');
				const [min, max] = fn.arity;
				if (args.length < min || args.length > max) {
					throw new MathExprError(`wrong number of arguments for ${t.value}()`);
				}
				return fn.run(...args);
			}
			if (t.value in CONSTANTS) return CONSTANTS[t.value];
			throw new MathExprError(`unknown name "${t.value}"`);
		}
		if (t.value === '(') {
			pos++;
			const value = expr();
			expect(')');
			return value;
		}
		throw new MathExprError(`unexpected "${t.value}" at position ${t.pos + 1}`);
	}

	if (tokens.length === 0) throw new MathExprError('empty expression');
	const value = expr();
	const rest = peek();
	if (rest) throw new MathExprError(`unexpected "${rest.value}" at position ${rest.pos + 1}`);
	return value;
}
